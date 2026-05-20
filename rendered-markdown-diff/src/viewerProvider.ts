import * as path from 'node:path';
import * as vscode from 'vscode';
import { ContentRef } from '../../shared/src/contentRef.js';
import { commitExists, readFileAtHead } from '../../shared/src/git.js';
import { gitRefUri, parseGitUri } from '../../shared/src/gitApi.js';
import { decodeGitGraphUri } from '../../shared/src/gitGraphUri.js';
import { renderPairedDiff, renderPlain, renderWithGutter } from './diff.js';
import { buildSinglePaneHtml, generateNonce } from './webview.js';

type PairResult = { originalUri: vscode.Uri; modifiedUri: vscode.Uri };

/**
 * 同時に開かれる diff editor の左右 pane を結び付けるための一時 buffer。
 *
 * `resolveCustomEditor` は片側ずつ呼ばれるので、自分のキーに対する sibling を
 * 短時間 polling で探し、見つかった瞬間に双方で diff context を共有する。
 *
 * key は「同じ論理ファイル」を識別する文字列:
 *   - file: / git: / gitfs: → URI の path 部分 (`/workspace/README.md` 等)
 *   - git-graph:         → `<repo>/<filePath>` (base64 query から復元)
 */
const pendingPairs = new Map<
    string,
    Array<{ uri: vscode.Uri; resolve: (pair: PairResult | undefined) => void }>
>();

/**
 * ペアになった webview パネル群 (スクロール同期用)。
 * key = pairing key。値は登録されている全 panel の配列。
 */
const pairedPanels = new Map<string, vscode.WebviewPanel[]>();

/**
 * ハイブリッド navigation history (案 B)。
 *
 * 遷移自体は実エディタを開く (`vscode.open` で preview タブを再利用) ままなので、
 * タブの URI バインドは常に正しく、Copy Path / Reveal / reopen-as-text / git
 * decoration 等の VSCode 機能との整合性は崩れない。その上で「訪問順だけ」を
 * 拡張側で記録し、戻る/進むは過去 URI を実エディタとして開き直すことで実現する。
 *
 * 各遷移は新しい panel を生む (= resolveCustomEditor が都度呼ばれる) ため、
 * パネル closure ではなく **module-level** に持つ。preview タブ再利用前提なので
 * 主用途 (1 列でリンクを辿る) では単一スタックで十分。複数列で同時に別系統を
 * 辿るケースは正確に追えない既知の割り切り。
 */
type NavIntent = 'push' | 'back' | 'forward';
const navHistory: { entries: vscode.Uri[]; index: number } = {
    entries: [],
    index: -1,
};
let pendingNavIntent: NavIntent | undefined;

/** リンク click 等の「新規遷移」直前に呼ぶ。次の resolve を push として扱わせる。 */
function markNavigationPush(): void {
    pendingNavIntent = 'push';
}

/**
 * resolveCustomEditor の単独モード経路から呼ぶ。pendingNavIntent に応じて
 * 履歴を更新する。
 *
 * intent 無しは「外部からの open」だが、`git:` 等 synthetic URI は VSCode が
 * フォーカス/復帰時に intent 無しで **再 resolve** することがある。これを毎回
 * 「新規セッション」にすると back 直後の再 resolve で forward 履歴が消える
 * (= 非 HEAD で一度戻ると進めない) ので、同一/既存エントリの再 resolve では
 * 履歴を壊さない:
 *   - 現在エントリと同じ URI       → 何もしない (再描画/再 resolve)
 *   - 履歴内の別エントリと同じ URI → index をそこへ移すだけ (前後を保持)
 *   - 完全に新規の URI            → 新しい履歴セッション
 */
function recordNavigationOnResolve(uri: vscode.Uri): void {
    const intent = pendingNavIntent;
    pendingNavIntent = undefined;
    if (intent === 'back' || intent === 'forward') {
        // index は navigateHistory() 側で既に動かしてあるので何もしない
        return;
    }
    if (intent === 'push') {
        navHistory.entries = navHistory.entries.slice(0, navHistory.index + 1);
        navHistory.entries.push(uri);
        navHistory.index = navHistory.entries.length - 1;
        return;
    }
    const key = uri.toString();
    if (navHistory.entries[navHistory.index]?.toString() === key) {
        return; // 同じ場所の再 resolve → 履歴維持
    }
    const existing = navHistory.entries.findIndex((e) => e.toString() === key);
    if (existing >= 0) {
        navHistory.index = existing; // 既存エントリへジャンプ (前後保持)
        return;
    }
    navHistory.entries = [uri];
    navHistory.index = 0;
}

/**
 * 自前履歴で戻る/進む。対象があれば実エディタとして開き直して true。
 * 無ければ false (呼び出し側で VSCode 標準 navigateBack/Forward にフォールバック)。
 */
async function navigateHistory(dir: 'back' | 'forward'): Promise<boolean> {
    const next = dir === 'back' ? navHistory.index - 1 : navHistory.index + 1;
    if (next < 0 || next >= navHistory.entries.length) return false;
    navHistory.index = next;
    pendingNavIntent = dir;
    await vscode.commands.executeCommand(
        'vscode.open',
        navHistory.entries[next],
        { viewColumn: vscode.ViewColumn.Active, preview: true },
    );
    return true;
}

/**
 * `*.md` のデフォルト custom editor。`customEditors.priority="default"` で登録され、
 * Explorer / Source Control diff / Git Graph diff 等から開かれる md はすべて
 * このプロバイダ経由で描画される。
 *
 * `CustomReadonlyEditorProvider` を選んでいる理由:
 *   - `CustomTextEditorProvider` を使うと VSCode が事前に `TextDocument` を
 *     ロードしようとし、`git-graph:` などの synthetic URI で
 *     「Unable to resolve resource」になって落ちる (特に Reload Window の
 *     revival 時)。CustomReadonlyEditor は CustomDocument を返すだけなので
 *     その経路を回避できる。
 *   - 中身の取得は `readFileAtRef` + `vscode.workspace.fs.readFile` を組み合わせて
 *     自前で行う。
 */
export class RenderedMarkdownDiffProvider
    implements vscode.CustomReadonlyEditorProvider<vscode.CustomDocument>
{
    static readonly viewType = 'xxxaz.rendered-markdown-diff';

    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly output: vscode.OutputChannel,
    ) {}

    openCustomDocument(uri: vscode.Uri): vscode.CustomDocument {
        // VSCode による TextDocument の resolution を経由しないため、URI を抱えるだけ
        return {
            uri,
            dispose: () => {
                // no-op
            },
        };
    }

    async resolveCustomEditor(
        document: vscode.CustomDocument,
        webviewPanel: vscode.WebviewPanel,
    ): Promise<void> {
        const uri = document.uri;
        this.output.appendLine(
            `[viewer.resolve] scheme=${uri.scheme} path=${uri.path} viewColumn=${webviewPanel.viewColumn}`,
        );

        webviewPanel.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                vscode.Uri.joinPath(this.context.extensionUri, 'media'),
            ],
        };
        const styleUri = webviewPanel.webview.asWebviewUri(
            vscode.Uri.joinPath(
                this.context.extensionUri,
                'media',
                'style.css',
            ),
        );
        const webviewScriptUri = webviewPanel.webview.asWebviewUri(
            vscode.Uri.joinPath(
                this.context.extensionUri,
                'media',
                'webview.js',
            ),
        );

        // 一度だけ pair 解決する: 再レンダリング時には pair を再 polling しない
        // (sibling は同タイミングでしか発火しないので、cache した結果を再利用すれば十分)
        const diffPair =
            findDiffPairContaining(uri) ?? (await coordinatePair(uri));

        // 単独モードのみ navigation history に記録 (diff は別タブ扱いで追わない)。
        // diff の場合も pendingNavIntent を消化しておく (誤って次の単独 open に
        // 持ち越さないため)。
        if (diffPair) {
            pendingNavIntent = undefined;
        } else {
            recordNavigationOnResolve(uri);
        }

        // ファイル変更時の再レンダリングで listener を入れ替えるための disposal 管理
        let actionSub: vscode.Disposable | undefined;
        let scrollSyncRegistered = false;
        const replaceActions = (opts: ActionHandlerOpts | undefined): void => {
            actionSub?.dispose();
            actionSub = opts
                ? setupActionHandlers(webviewPanel, opts)
                : undefined;
        };
        const ensureScrollSync = (): void => {
            if (scrollSyncRegistered) return;
            registerForScrollSync(webviewPanel, uri);
            scrollSyncRegistered = true;
        };

        // 単一レンダリング動作。初回 + file watcher による change 通知で再呼び出しされる。
        const renderOnce = async (): Promise<void> => {
            await this.renderInto(
                webviewPanel,
                uri,
                diffPair,
                {
                    styleUri,
                    webviewScriptUri,
                    cspSource: webviewPanel.webview.cspSource,
                },
                replaceActions,
                ensureScrollSync,
            );
        };

        await renderOnce();

        // file: URI を FileSystemWatcher で監視し、変更されたら自動再描画する。
        //
        // - 単独 file: → 自身の URI を watch
        // - diff モード → diffPair の両側のうち file: scheme のものを watch
        //
        // change / create / delete の **全イベント** を listen する理由:
        //
        // VSCode 内蔵 editor の save は inotify の WRITE を発火させるので `change`
        // で拾える。一方、Claude Code の Edit / Write tool 等の外部ライター系は
        // 「temp file に書いて rename」する atomic write を使うことがあり、
        // その場合 inotify は MOVED_TO になり、VSCode 側では `create` イベントとして
        // 観測される (`change` は来ない)。両方拾わないと「自分で別タブから save」
        // するケースだけ反応して、外部ライターには反応しない事象になる。
        //
        // 重複発火を避けるため 100ms debounce を入れる。
        const rerender = debounce(() => {
            renderOnce().catch((err) => {
                this.output.appendLine(
                    `[re-render] error: ${err instanceof Error ? err.message : String(err)}`,
                );
            });
        }, 100);
        const watchUris = collectWatchFileUris(uri, diffPair);
        const watchers: vscode.FileSystemWatcher[] = watchUris.map(
            (fileUri) => {
                const watcher = vscode.workspace.createFileSystemWatcher(
                    new vscode.RelativePattern(
                        vscode.Uri.file(path.dirname(fileUri.fsPath)),
                        path.basename(fileUri.fsPath),
                    ),
                    false, // listen create (atomic rename → create as MOVED_TO)
                    false, // listen change (in-place writes)
                    false, // listen delete (削除も追従して error 表示に倒す)
                );
                watcher.onDidChange(rerender);
                watcher.onDidCreate(rerender);
                watcher.onDidDelete(rerender);
                return watcher;
            },
        );

        webviewPanel.onDidDispose(() => {
            actionSub?.dispose();
            for (const w of watchers) w.dispose();
        });
    }

    /**
     * resolveCustomEditor の初回呼び出しおよびファイル変更による再描画から呼ばれる
     * 単発レンダリング。diffPair の有無 / URI scheme / HEAD 内容との差分等に応じて
     * 分岐し、webview.html と action handler を入れ替える。
     */
    private async renderInto(
        webviewPanel: vscode.WebviewPanel,
        uri: vscode.Uri,
        diffPair: PairResult | undefined,
        urls: {
            styleUri: vscode.Uri;
            webviewScriptUri: vscode.Uri;
            cspSource: string;
        },
        replaceActions: (opts: ActionHandlerOpts | undefined) => void,
        ensureScrollSync: () => void,
    ): Promise<void> {
        const { styleUri, webviewScriptUri, cspSource } = urls;
        const isDiff = !!diffPair;

        // --- (1) 描画ロジック (モード別に bodyHtml / subtitle / bodyClass を決める) ---
        let bodyHtml: string;
        let subtitle: string;
        let bodyClass: string | undefined;

        if (diffPair) {
            const isOriginal =
                uri.toString() === diffPair.originalUri.toString();
            const isModified =
                uri.toString() === diffPair.modifiedUri.toString();

            const [origText, modText] = await Promise.all([
                fetchContent(diffPair.originalUri),
                fetchContent(diffPair.modifiedUri),
            ]);

            const commitShas = await collectConfirmedShas(uri, [
                origText ?? '',
                modText ?? '',
            ]);
            const render = renderPairedDiff(origText ?? '', modText ?? '', {
                commitShas,
            });
            // Git Graph の「追加/削除されたファイル」の diff では片側 URI が
            // exists:false な git-graph で content が undefined になる。空 render だと
            // 真っ白で何が起きたか分からないので placeholder を出す。
            const myContent = isModified
                ? modText
                : isOriginal
                  ? origText
                  : modText;
            const sideLabel = isModified
                ? 'modified'
                : isOriginal
                  ? 'original'
                  : 'unknown';
            bodyHtml =
                myContent === undefined
                    ? '<p class="mdd-empty">この commit / ref にはこのファイルが存在しません</p>'
                    : isModified
                      ? render.currentHtml
                      : isOriginal
                        ? render.headHtml
                        : render.currentHtml;
            subtitle = `${describeUri(uri)} [${sideLabel}] (+${render.summary.added} / -${render.summary.removed})`;
        } else {
            const content = await fetchContent(uri);
            if (content === undefined) {
                webviewPanel.webview.html = buildSinglePaneHtml({
                    title: displayBasename(uri),
                    subtitle: `${describeUri(uri)} (内容取得失敗)`,
                    bodyHtml:
                        '<p class="mdd-empty">ファイル内容を取得できませんでした</p>',
                    styleUri,
                    webviewScriptUri,
                    cspSource,
                    nonce: generateNonce(),
                });
                replaceActions(undefined);
                return;
            }

            const commitShas = await collectConfirmedShas(uri, [content]);
            const renderEnv = { commitShas };
            if (uri.scheme === 'file') {
                const head = await readFileAtHead(uri);
                if (head.kind === 'found' && head.content !== content) {
                    const render = renderWithGutter(
                        head.content,
                        content,
                        renderEnv,
                    );
                    bodyHtml = render.html;
                    bodyClass = 'mdd-single-gutter';
                    subtitle = `${describeUri(uri)} (vs HEAD: +${render.summary.added} / ~${render.summary.modified} / -${render.summary.removed})`;
                } else if (head.kind === 'not-in-head') {
                    const render = renderWithGutter('', content, renderEnv);
                    bodyHtml = render.html;
                    bodyClass = 'mdd-single-gutter';
                    subtitle = `${describeUri(uri)} (HEAD に存在しない / 全行追加扱い)`;
                } else {
                    bodyHtml = renderPlain(content, renderEnv);
                    subtitle = describeUri(uri);
                }
            } else {
                bodyHtml = renderPlain(content, renderEnv);
                subtitle = describeUri(uri);
            }
        }

        // --- (2) アクションは単独/比較を問わず uri から一律算出 ---
        //     (diff モードでは ↔ HEAD / ↔ Worktree / → Worktree の冗長分を抑制)
        const { config, handler } = await computeActions(uri, diffPair);

        webviewPanel.webview.html = buildSinglePaneHtml({
            title: displayBasename(uri),
            subtitle,
            bodyHtml,
            styleUri,
            webviewScriptUri,
            cspSource,
            nonce: generateNonce(),
            bodyClass,
            actions: { ...config, subtitleAsOpenSingle: isDiff },
        });

        if (isDiff) {
            // sister pane との scroll 同期 (初回のみ登録)
            ensureScrollSync();
        }
        replaceActions({
            currentUri: uri,
            // subtitle クリックで単独 viewer を開けるのは diff モード時のみ
            openSingleUri: isDiff ? uri : undefined,
            ...handler,
            // 比較 viewer 内のリンクは同じコミットペアで比較を開くため両側 URI を渡す
            linkDiffContext: diffPair
                ? {
                      originalUri: diffPair.originalUri,
                      modifiedUri: diffPair.modifiedUri,
                  }
                : undefined,
            // diff editor の片側は tab 単位 reopen が効かないので diff-side
            textEditorMode: isDiff ? 'diff-side' : 'standalone',
        });
    }
}

/**
 * 連続イベントを最後の発火から `wait` ms 後に 1 回だけ実行する単純 debounce。
 * file watcher で atomic rename (delete+create) や 2 連発の write を 1 回にまとめる用途。
 */
function debounce<TArgs extends unknown[]>(
    fn: (...args: TArgs) => void,
    wait: number,
): (...args: TArgs) => void {
    let timer: ReturnType<typeof setTimeout> | undefined;
    return (...args: TArgs) => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
            timer = undefined;
            fn(...args);
        }, wait);
    };
}

/**
 * file watcher を仕掛ける対象の file: URI 集合を、表示中の URI と diffPair から決める。
 *
 *   - 単独表示で uri.scheme === 'file' → [uri]
 *   - diff モード → diffPair の両側のうち file: scheme のものすべて
 *
 * git: / git-graph: 等の synthetic scheme は filesystem 上で変化しないので watch しない。
 */
function collectWatchFileUris(
    uri: vscode.Uri,
    diffPair: PairResult | undefined,
): vscode.Uri[] {
    const out: vscode.Uri[] = [];
    if (uri.scheme === 'file') out.push(uri);
    if (diffPair) {
        if (diffPair.originalUri.scheme === 'file')
            out.push(diffPair.originalUri);
        if (diffPair.modifiedUri.scheme === 'file')
            out.push(diffPair.modifiedUri);
    }
    const seen = new Set<string>();
    return out.filter((u) => {
        if (seen.has(u.fsPath)) return false;
        seen.add(u.fsPath);
        return true;
    });
}

/**
 * 非 file: scheme から「作業ツリー側 file: URI」を導出する。
 *   - `git:` / `gitfs:` → `uri.path` がそのまま絶対パスなので scheme を file に
 *   - `git-graph:`     → base64 query を decode して `<repo>/<filePath>` を file: に
 *
 * 解決できない (scheme 未対応 / git-graph decode 失敗) 場合は undefined。
 */
function deriveWorkingTreeUri(uri: vscode.Uri): vscode.Uri | undefined {
    const wt = ContentRef.from(uri).toWorktree();
    // file: は自分自身が作業ツリーなので「導出」とは見なさない (従来挙動を維持)
    if (!wt || wt.uri.toString() === uri.toString()) return undefined;
    return wt.uri;
}

/**
 * `rmd-source:` scheme: ref 内容を read-only テキストとして見せるための仮想ドキュメント。
 * `query` に元 URI 文字列の base64 を持たせ、`provideTextDocumentContent` で
 * `fetchContent` を通して内容を返す。`TextDocumentContentProvider` 由来なので
 * 保存先が無く、自動的に read-only になる。
 */
const RMD_SOURCE_SCHEME = 'rmd-source';

class RmdSourceContentProvider implements vscode.TextDocumentContentProvider {
    async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
        try {
            const originalStr = Buffer.from(
                decodeURIComponent(uri.query),
                'base64',
            ).toString('utf-8');
            const original = vscode.Uri.parse(originalStr);
            const content = await fetchContent(original);
            return content ?? '(コンテンツを取得できませんでした)';
        } catch {
            return '(コンテンツを取得できませんでした)';
        }
    }
}

export function registerRmdSourceProvider(
    context: vscode.ExtensionContext,
): void {
    context.subscriptions.push(
        vscode.workspace.registerTextDocumentContentProvider(
            RMD_SOURCE_SCHEME,
            new RmdSourceContentProvider(),
        ),
    );
}

/**
 * 元 URI を `rmd-source:` 仮想 URI に変換する。
 * path 末尾を `.md` に揃えて markdown ハイライトを得る (scheme が file: ではないので
 * customEditor priority=default には乗らず、`showTextDocument` で素のテキストになる)。
 */
function makeSourceTextUri(originalUri: vscode.Uri): vscode.Uri {
    const b64 = Buffer.from(originalUri.toString(), 'utf-8').toString('base64');
    const base = displayBasename(originalUri);
    const name = base.toLowerCase().endsWith('.md') ? base : `${base}.md`;
    return vscode.Uri.parse(
        `${RMD_SOURCE_SCHEME}:/${name}?${encodeURIComponent(b64)}`,
    );
}

/**
 * pane が表示している URI から、単独/比較を問わず一律にアクション集合を算出する。
 * 「相互切替 (タブアイコン)」以外はモードで出し分けせず URI scheme + git 文脈で決める。
 *
 *   - file: → ✎ Edit / (git 管理下なら) ↔ HEAD
 *   - 非 file: (git: / gitfs: / git-graph:) → ↔ Worktree(diff) / → Worktree(開く) / </> Source
 *     → Worktree は対応ファイルが実在する時のみ有効、無ければ disabled 表示
 */
async function computeActions(
    uri: vscode.Uri,
    diffPair: PairResult | undefined,
): Promise<{
    config: {
        openText?: boolean;
        openHeadDiff?: boolean;
        openWorkingTreeDiff?: boolean;
        openWorktree?: boolean;
        openWorktreeDisabled?: boolean;
        openSourceText?: boolean;
        openCommitBrowser?: boolean;
        openCompareBrowser?: boolean;
    };
    handler: Pick<
        ActionHandlerOpts,
        | 'openTextUri'
        | 'openHeadDiffUri'
        | 'openWorkingTreeDiff'
        | 'openWorktreeUri'
        | 'openSourceTextUri'
    >;
}> {
    // diff モードでは既に「比較中」なので ↔ HEAD / ↔ Worktree は冗長 → 出さない。
    const inDiff = !!diffPair;
    // diff の片側が file: (= 作業ツリー) なら worktree は既に画面にある → → Worktree 不要。
    const diffHasWorktreeSide =
        inDiff &&
        (diffPair.originalUri.scheme === 'file' ||
            diffPair.modifiedUri.scheme === 'file');
    // ⎇ Compare は比較の **右(modified) pane のみ** に出す (両 pane だと冗長)
    const showCompare =
        inDiff && uri.toString() === diffPair.modifiedUri.toString();

    if (uri.scheme === 'file') {
        const head = await readFileAtHead(uri);
        const inRepo = head.kind === 'found' || head.kind === 'not-in-head';
        const showHeadDiff = !inDiff && inRepo;
        return {
            config: {
                openText: true,
                openHeadDiff: showHeadDiff,
                openCommitBrowser: true,
                openCompareBrowser: showCompare,
            },
            handler: {
                openTextUri: uri,
                openHeadDiffUri: showHeadDiff ? uri : undefined,
                openWorkingTreeDiff: undefined,
                openWorktreeUri: undefined,
                openSourceTextUri: undefined,
            },
        };
    }

    // 非 file: (git: / gitfs: / git-graph:)
    const wt = deriveWorkingTreeUri(uri);
    let wtExists = false;
    if (wt) {
        try {
            await vscode.workspace.fs.stat(wt);
            wtExists = true;
        } catch {
            wtExists = false;
        }
    }
    const showWtDiff = !inDiff && !!wt;
    const showOpenWt = !diffHasWorktreeSide && !!wt && wtExists;
    const showOpenWtDisabled = !diffHasWorktreeSide && !!wt && !wtExists;
    return {
        config: {
            openWorkingTreeDiff: showWtDiff,
            openWorktree: showOpenWt ? true : undefined,
            openWorktreeDisabled: showOpenWtDisabled ? true : undefined,
            openSourceText: true,
            openCommitBrowser: true,
            openCompareBrowser: showCompare,
        },
        handler: {
            openTextUri: undefined,
            openHeadDiffUri: undefined,
            openWorkingTreeDiff:
                showWtDiff && wt ? { fromUri: uri, toUri: wt } : undefined,
            openWorktreeUri: showOpenWt ? wt : undefined,
            openSourceTextUri: uri,
        },
    };
}

/**
 * webview から飛んでくる action (openText / openHeadDiff / openWorkingTreeDiff /
 * openSingle) を受け取り、対応する VSCode コマンドを実行する。
 * 各 action の対象 URI は呼び出し側で確定させて渡す。
 *
 * `textEditorMode` は openText の挙動切替:
 *   - `'standalone'` → 同じ tab に対して `workbench.action.reopenTextEditor` を叩く
 *     (panel は単独 tab なので tab そのものが text editor に置き換わる)
 *   - `'diff-side'` → diff editor の片側として表示されているため、tab に対して
 *     reopenTextEditor を叩いても diff 全体が再描画されるだけになる。
 *     代わりに `showTextDocument` で対象 file: を **新規 text editor として** 開く。
 */
type ActionHandlerOpts = {
    /** 自分自身が表示している URI (markdown 内 relative link 解決の基準) */
    currentUri: vscode.Uri;
    /** subtitle クリック (openSingle) の対象。diff pane の自分側 URI */
    openSingleUri: vscode.Uri | undefined;
    /** 「✎ Edit」対象 (file: scheme のみ意味あり) */
    openTextUri: vscode.Uri | undefined;
    /** 「↔ HEAD」対象 (file: scheme + git 管理下のみ意味あり) */
    openHeadDiffUri: vscode.Uri | undefined;
    /** 「↔ Worktree」(diff) 対象 (非 file: scheme で作業ツリー URI が導出できる時) */
    openWorkingTreeDiff: { fromUri: vscode.Uri; toUri: vscode.Uri } | undefined;
    /** 「→ Worktree」対象 (対応する作業ツリーファイルが実在する時) */
    openWorktreeUri: vscode.Uri | undefined;
    /** 「</> Source」対象 (この ref 内容を read-only テキストで開く: 非 file: 時) */
    openSourceTextUri: vscode.Uri | undefined;
    /**
     * diff モード時の両側 URI。markdown 内リンクを click した際、単独 viewer ではなく
     * **同じコミットペアを維持した比較 viewer** で対象ファイルを開くために使う。
     * 単独モードでは undefined。
     */
    linkDiffContext?: { originalUri: vscode.Uri; modifiedUri: vscode.Uri };
    /** openText の挙動切替。デフォルトは 'standalone' */
    textEditorMode?: 'standalone' | 'diff-side';
};

/**
 * `Disposable` を返すので、ファイル変更による再レンダリング時に呼び出し側で
 * `dispose()` してから付け直すことで listener が累積しないようにできる。
 */
function setupActionHandlers(
    panel: vscode.WebviewPanel,
    opts: ActionHandlerOpts,
): vscode.Disposable {
    const sub = panel.webview.onDidReceiveMessage(async (msg) => {
        if (!msg || typeof msg.type !== 'string') return;
        // scroll は registerForScrollSync 側で扱うのでここでは無視
        if (msg.type === 'scroll') return;

        try {
            switch (msg.type) {
                case 'openText':
                    if (opts.openTextUri)
                        await openInTextEditor(
                            panel,
                            opts.openTextUri,
                            opts.textEditorMode ?? 'standalone',
                        );
                    return;
                case 'openHeadDiff':
                    if (opts.openHeadDiffUri)
                        await openHeadDiff(opts.openHeadDiffUri);
                    return;
                case 'openWorkingTreeDiff':
                    if (opts.openWorkingTreeDiff)
                        await openWorkingTreeDiff(opts.openWorkingTreeDiff);
                    return;
                case 'openWorktree':
                    if (opts.openWorktreeUri)
                        await openInViewer(
                            opts.openWorktreeUri,
                            msg.newTab === true,
                        );
                    return;
                case 'openSourceText':
                    if (opts.openSourceTextUri)
                        await vscode.window.showTextDocument(
                            makeSourceTextUri(opts.openSourceTextUri),
                            {
                                preview: msg.newTab !== true,
                                viewColumn: vscode.ViewColumn.Active,
                            },
                        );
                    return;
                case 'openSingle':
                    if (opts.openSingleUri)
                        await openInViewer(
                            opts.openSingleUri,
                            msg.newTab === true,
                        );
                    return;
                case 'openLink':
                    if (typeof msg.href === 'string') {
                        if (opts.linkDiffContext) {
                            // 比較 viewer 内のリンク → コミットペアを維持して比較を開く
                            await openRelativeLinkAsDiff(
                                opts.linkDiffContext.originalUri,
                                opts.linkDiffContext.modifiedUri,
                                msg.href,
                                msg.newTab === true,
                            );
                        } else {
                            await openRelativeLink(
                                opts.currentUri,
                                msg.href,
                                msg.newTab === true,
                            );
                        }
                    }
                    return;
                case 'openExternal':
                    if (typeof msg.href === 'string') {
                        // GitHub/GitLab の commit/blob URL なら commit ナビへ橋渡し。
                        // それ以外は通常どおり外部ブラウザ。
                        if (
                            !(await routeCommitUrl(opts.currentUri, msg.href))
                        ) {
                            await vscode.env.openExternal(
                                vscode.Uri.parse(msg.href),
                            );
                        }
                    }
                    return;
                case 'openCommitRef':
                    if (typeof msg.ref === 'string')
                        await openCommitRef(opts.currentUri, {
                            kind: msg.kind === 'blob' ? 'blob' : 'commit',
                            ref: msg.ref,
                            file:
                                typeof msg.file === 'string'
                                    ? msg.file
                                    : undefined,
                            href:
                                typeof msg.href === 'string'
                                    ? msg.href
                                    : undefined,
                        });
                    return;
                case 'openCommitBrowser':
                    await openCommitBrowserForCurrent(opts.currentUri);
                    return;
                case 'openCompareBrowser':
                    if (opts.linkDiffContext)
                        await openCompareForPair(
                            opts.currentUri,
                            opts.linkDiffContext.originalUri,
                            opts.linkDiffContext.modifiedUri,
                        );
                    return;
                case 'historyBack':
                    // 自前履歴で戻れれば実エディタ遷移、無ければ VSCode 標準にフォールバック
                    if (!(await navigateHistory('back')))
                        await vscode.commands.executeCommand(
                            'workbench.action.navigateBack',
                        );
                    return;
                case 'historyForward':
                    if (!(await navigateHistory('forward')))
                        await vscode.commands.executeCommand(
                            'workbench.action.navigateForward',
                        );
                    return;
            }
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            vscode.window.showWarningMessage(
                `Rendered Markdown Diff: ${message}`,
            );
        }
    });
    return sub;
}

/**
 * markdown 中の相対 / 絶対パス href を「base URI と同じ文脈」の URI に解決する。
 *
 *   - `file:`        → `path.resolve` で対象 file: URI
 *   - `git-graph:`   → 同じ repo / commit の別 filePath を指す git-graph URI を再構築
 *   - `git:` / `gitfs:` → 同じ scheme で path を差し替え
 *
 * `#fragment` は preserve (custom editor 側 anchor scroll は未実装なので現状 no-op)。
 * scheme 未対応 / git-graph decode 失敗時は undefined。
 */
function resolveLinkTarget(
    baseUri: vscode.Uri,
    href: string,
): vscode.Uri | undefined {
    return ContentRef.from(baseUri).resolveRelative(href)?.uri;
}

const README_NAMES = ['README.md', 'readme.md', 'README.markdown'];

/**
 * リンク先がディレクトリなら GitHub 同様その配下の README へ振り替える。
 *   - `file:`  → stat してディレクトリなら README.md 系の実在を優先採用
 *   - `git:`   → stat 不可なので「拡張子なし最終要素 = ディレクトリ」heuristic で
 *                同 ref の `<dir>/README.md` に振り替え
 * 振り替え不要 / 不能ならそのまま返す。
 */
async function resolveDirToReadme(uri: vscode.Uri): Promise<vscode.Uri> {
    if (uri.scheme === 'file') {
        try {
            const st = await vscode.workspace.fs.stat(uri);
            if (st.type & vscode.FileType.Directory) {
                for (const n of README_NAMES) {
                    const c = vscode.Uri.joinPath(uri, n);
                    try {
                        const cs = await vscode.workspace.fs.stat(c);
                        if (cs.type & vscode.FileType.File) return c;
                    } catch {
                        // 候補なし
                    }
                }
                return vscode.Uri.joinPath(uri, 'README.md');
            }
        } catch {
            // 存在しない → 振り替えず元のまま (リンク切れは呼出側で表示)
        }
        return uri;
    }
    const g = parseGitUri(uri);
    if (g) {
        const last = g.fsPath.split('/').pop() ?? '';
        if (last !== '' && !last.includes('.')) {
            return gitRefUri(`${g.fsPath}/README.md`, g.ref);
        }
    }
    return uri;
}

/**
 * 単独 viewer 内のリンク click。`baseUri` と同じ文脈で対象を開く。
 * 通常クリック → 同 column の preview タブで「タブ内切替」、Ctrl/中クリック → 別タブ。
 */
async function openRelativeLink(
    baseUri: vscode.Uri,
    href: string,
    newTab: boolean,
): Promise<void> {
    const resolved = resolveLinkTarget(baseUri, href);
    if (!resolved) return;
    const target = await resolveDirToReadme(resolved);
    // 新規遷移として history に積む (次の resolve が push 扱いになる)
    markNavigationPush();
    await vscode.commands.executeCommand('vscode.open', target, {
        viewColumn: vscode.ViewColumn.Active,
        preview: !newTab,
    });
}

/**
 * 比較 viewer 内のリンク click。元の original/modified コミットペアを維持したまま、
 * 対象ファイルの **比較** を開く (`vscode.diff` → smart viewer が coordinatePair で結合)。
 * 片側しか解決できない場合は単独で開くフォールバック。
 */
async function openRelativeLinkAsDiff(
    originalUri: vscode.Uri,
    modifiedUri: vscode.Uri,
    href: string,
    newTab: boolean,
): Promise<void> {
    const o0 = resolveLinkTarget(originalUri, href);
    const m0 = resolveLinkTarget(modifiedUri, href);
    const o = o0 ? await resolveDirToReadme(o0) : undefined;
    const m = m0 ? await resolveDirToReadme(m0) : undefined;
    if (o && m) {
        const label = `${path.posix.basename(href.split('#')[0])} (${describeUri(o)} ↔ ${describeUri(m)})`;
        await vscode.commands.executeCommand('vscode.diff', o, m, label, {
            preview: !newTab,
        });
        return;
    }
    const fallback = m ?? o;
    if (fallback) {
        await vscode.commands.executeCommand('vscode.open', fallback, {
            viewColumn: vscode.ViewColumn.Active,
            preview: !newTab,
        });
    }
}

/**
 * 「テキストで開く」アクションを実行する。
 *
 *   - `standalone`: 自 tab に `workbench.action.reopenTextEditor` を投げて同じ tab を
 *     text editor に置き換える
 *   - `diff-side`:  自分は diff editor の片側で、tab 単位の reopen はうまく機能しないため、
 *     `showTextDocument(uri)` で隣接 view column に新規 text editor として開く
 */
async function openInTextEditor(
    panel: vscode.WebviewPanel,
    uri: vscode.Uri,
    mode: 'standalone' | 'diff-side',
): Promise<void> {
    if (mode === 'standalone') {
        panel.reveal(undefined, false);
        await vscode.commands.executeCommand(
            'workbench.action.reopenTextEditor',
        );
        return;
    }
    await vscode.window.showTextDocument(uri, {
        viewColumn: vscode.ViewColumn.Beside,
        preview: false,
    });
}

/**
 * 「作業ツリーと比較」アクション。`vscode.diff(fromUri, toUri, label)` を実行して
 * TabInputTextDiff を生成し、smart viewer の coordinatePair が両側を結合する。
 */
async function openWorkingTreeDiff(opts: {
    fromUri: vscode.Uri;
    toUri: vscode.Uri;
}): Promise<void> {
    const label = `${path.basename(opts.toUri.path)} (${describeUri(opts.fromUri)} ↔ 作業ツリー)`;
    await vscode.commands.executeCommand(
        'vscode.diff',
        opts.fromUri,
        opts.toUri,
        label,
    );
}

/**
 * 対象 file: URI と HEAD 版 (git: scheme) との diff editor を開く。
 * 結果として TabInputTextDiff が立ち上がり、smart viewer の coordinatePair が両側を結合する。
 */
async function openHeadDiff(uri: vscode.Uri): Promise<void> {
    if (uri.scheme !== 'file') return;
    const headUri = gitRefUri(uri.fsPath, 'HEAD');
    const label = `${displayBasename(uri)} (HEAD ↔ 作業ツリー)`;
    await vscode.commands.executeCommand('vscode.diff', headUri, uri, label);
}

/**
 * 任意 URI を viewer で開く。`vscode.open` 経由なので `*.md` なら smart viewer が
 * default として起動する (sibling が来なければ単独表示)。
 *
 *   - `newTab=false` (通常クリック) → アクティブ column の **preview タブ** で開く。
 *     連続ナビゲーション時は同じ preview タブが置き換わるので「タブ内切替」になる
 *   - `newTab=true` (Ctrl/⌘ or 中クリック) → preview にせず別タブで開く
 */
async function openInViewer(uri: vscode.Uri, newTab: boolean): Promise<void> {
    // 新規遷移として history に積む
    markNavigationPush();
    await vscode.commands.executeCommand('vscode.open', uri, {
        viewColumn: vscode.ViewColumn.Active,
        preview: !newTab,
    });
}

/**
 * webview を pairing key 配下に登録し、sister pane から届く scroll メッセージを
 * 自分以外の peer へ中継する。panel が dispose されたら登録解除する。
 */
function registerForScrollSync(
    panel: vscode.WebviewPanel,
    uri: vscode.Uri,
): void {
    const key = pairingKey(uri);
    if (!key) return;

    const peers = pairedPanels.get(key) ?? [];
    peers.push(panel);
    pairedPanels.set(key, peers);

    const messageSub = panel.webview.onDidReceiveMessage((msg) => {
        if (!msg || msg.type !== 'scroll') return;
        const list = pairedPanels.get(key);
        if (!list) return;
        for (const peer of list) {
            if (peer === panel) continue;
            peer.webview.postMessage(msg);
        }
    });

    panel.onDidDispose(() => {
        messageSub.dispose();
        const list = pairedPanels.get(key);
        if (!list) return;
        const filtered = list.filter((p) => p !== panel);
        if (filtered.length === 0) pairedPanels.delete(key);
        else pairedPanels.set(key, filtered);
    });
}

/**
 * 指定 URI が片側として含まれる `TabInputTextDiff` を探す。
 * 見つかった場合は両側の URI を返す。
 */
function findDiffPairContaining(uri: vscode.Uri): PairResult | undefined {
    const target = uri.toString();
    for (const group of vscode.window.tabGroups.all) {
        for (const tab of group.tabs) {
            const input = tab.input;
            if (!(input instanceof vscode.TabInputTextDiff)) continue;
            if (
                input.original.toString() === target ||
                input.modified.toString() === target
            ) {
                return {
                    originalUri: input.original,
                    modifiedUri: input.modified,
                };
            }
        }
    }
    return undefined;
}

/**
 * 同じ論理ファイルを指す 2 URI を識別するための pairing key。
 *   - git-graph: → `<repo>/<filePath>` (base64 query から復元)
 *   - それ以外 (file: / git: / gitfs: / gitlens: / Claude Code の
 *     `_claude_vscode_fs_*:` 編集差分等) → path 部分
 *
 * git-graph 以外は path ベースに一般化している。これで `file:` (現行) ↔
 * `_claude_vscode_fs_right:` (提案) のような別 scheme 同士の diff も結合でき、
 * 編集プレビューが 2 ペインのレンダリング diff になる (coordinatePair は
 * 同時刻の 2 resolve = diff editor 想定なので誤マッチ余地は小さい)。
 */
function pairingKey(uri: vscode.Uri): string | undefined {
    if (uri.scheme === 'git-graph') {
        const gg = decodeGitGraphUri(uri);
        if (!gg?.repo) return undefined;
        return path.posix.normalize(`${gg.repo}/${gg.filePath}`);
    }
    if (uri.path) return path.posix.normalize(uri.path);
    return undefined;
}

/**
 * 2 つの URI からどちらが original / modified かを推定する。
 *   - 片方が file: → そちらが modified (作業ツリー)、もう片方が original
 *   - 両方とも git: / gitfs: → query に "HEAD" を含む側を original (heuristic)
 *   - 両方とも git-graph: → commit が `^` で終わる側 (= 親) を original
 *   - 判定不能なら先に登録された側を original にする
 */
function orderPair(a: vscode.Uri, b: vscode.Uri): PairResult {
    // file: は modified 側として扱う
    if (a.scheme === 'file' && b.scheme !== 'file')
        return { originalUri: b, modifiedUri: a };
    if (b.scheme === 'file' && a.scheme !== 'file')
        return { originalUri: a, modifiedUri: b };

    // git-graph: 同士は commit に `^` が付いた方を original
    if (a.scheme === 'git-graph' && b.scheme === 'git-graph') {
        const ag = decodeGitGraphUri(a);
        const bg = decodeGitGraphUri(b);
        if (ag && bg) {
            if (ag.ref.endsWith('^') && !bg.ref.endsWith('^'))
                return { originalUri: a, modifiedUri: b };
            if (bg.ref.endsWith('^') && !ag.ref.endsWith('^'))
                return { originalUri: b, modifiedUri: a };
        }
    }

    // tiebreaker: a を original にする (登録順依存)
    return { originalUri: a, modifiedUri: b };
}

/**
 * 同じ pairing key を持つ sibling が短時間に登録されるのを待つ。
 *
 * resolveCustomEditor が左右 pane 双方で呼ばれる diff editor 想定。
 * sibling が来なかったら undefined を返し、呼び出し側は単独 preview にフォールバック。
 */
function coordinatePair(
    uri: vscode.Uri,
    waitMs = 400,
): Promise<PairResult | undefined> {
    const key = pairingKey(uri);
    if (!key) return Promise.resolve(undefined);

    return new Promise((resolve) => {
        const entry = { uri, resolve };
        const list = pendingPairs.get(key) ?? [];
        list.push(entry);
        pendingPairs.set(key, list);

        // sibling が既に登録済みなら即時 resolve
        const sibling = list.find((e) => e.uri.toString() !== uri.toString());
        if (sibling) {
            const pair = orderPair(sibling.uri, uri);
            // 双方を resolve して buffer から除去
            pendingPairs.delete(key);
            for (const e of list) e.resolve(pair);
            return;
        }

        // 一定時間 sibling を待つ。来なければ単独として undefined
        const timeout = setTimeout(() => {
            const cur = pendingPairs.get(key);
            if (!cur) return;
            const remaining = cur.filter((e) => e !== entry);
            if (remaining.length === 0) pendingPairs.delete(key);
            else pendingPairs.set(key, remaining);
            resolve(undefined);
        }, waitMs);

        // resolve が外部から先に呼ばれたら timeout を打ち消す
        const origResolve = entry.resolve;
        entry.resolve = (pair) => {
            clearTimeout(timeout);
            origResolve(pair);
        };
    });
}

/**
 * URI scheme 別の内容取得。
 *   - `file:`         → 作業ツリーから読み込み
 *   - `git:` / `gitfs:` → VSCode の git extension provider 経由 (HEAD / index 等)
 *   - `git-graph:`    → base64 query を decode して readFileAtRef で commit 内容取得
 *
 * 失敗 (provider 未起動 / ref 未存在 等) は undefined を返す。
 */
async function fetchContent(uri: vscode.Uri): Promise<string | undefined> {
    return ContentRef.from(uri).read();
}

function describeUri(uri: vscode.Uri): string {
    return ContentRef.from(uri).describe();
}

/**
 * 表示テキスト中の bare SHA 候補のうち `uri` が属する repo に実在する commit
 * だけを返す (GitHub の autolink と同じ verify-before-link)。候補ゼロなら
 * repo 解決もせず即 return。git 呼び出し過多を避け候補は 40 件で打ち切る。
 */
async function collectConfirmedShas(
    uri: vscode.Uri,
    sources: string[],
): Promise<Set<string>> {
    const re = /\b[0-9a-f]{7,40}\b/g;
    const candidates = new Set<string>();
    for (const s of sources) {
        re.lastIndex = 0;
        let m: RegExpExecArray | null = re.exec(s);
        while (m !== null && candidates.size < 40) {
            candidates.add(m[0]);
            m = re.exec(s);
        }
        if (candidates.size >= 40) break;
    }
    if (candidates.size === 0) return new Set();
    const repo = await ContentRef.from(uri).gitRepoRoot();
    if (!repo) return new Set();
    const confirmed = new Set<string>();
    await Promise.all(
        [...candidates].map(async (sha) => {
            if (await commitExists(repo, sha)) confirmed.add(sha);
        }),
    );
    return confirmed;
}

const GIT_COMMIT_BROWSER_CMD = 'xxxaz.git-commit-browser.open';

/**
 * 本文中のコミット参照クリックを別拡張 `git-commit-browser` のコマンドへ橋渡しする。
 * コマンドが無い (拡張無効) 場合は href があれば外部ブラウザ、無ければ警告。
 */
async function openCommitRef(
    baseUri: vscode.Uri,
    args: {
        kind: 'commit' | 'blob';
        ref: string;
        file?: string;
        href?: string;
    },
): Promise<void> {
    try {
        await vscode.commands.executeCommand(GIT_COMMIT_BROWSER_CMD, {
            ...args,
            uri: baseUri.toString(),
        });
    } catch {
        if (args.href) {
            await vscode.env.openExternal(vscode.Uri.parse(args.href));
        } else {
            vscode.window.showWarningMessage(
                'Rendered Markdown Diff: Git Commit Browser 拡張が利用できません',
            );
        }
    }
}

// GitHub/GitLab の commit / blob URL。webview ではなく host (通常 TS) 側で判定する
// (webview の埋め込みスクリプトは template literal 内でバックスラッシュ正規表現を
//  置けないため)。commitLinkProvider と同一パターン。
const COMMIT_URL_RE =
    /^https?:\/\/[^\s)<>"']+?\/(?:-\/)?commit\/([0-9a-f]{7,40})\b/i;
const BLOB_URL_RE =
    /^https?:\/\/[^\s)<>"']+?\/(?:-\/)?blob\/([^/\s)<>"']+)\/([^\s)<>"']+)/i;

/**
 * href が GitHub/GitLab の commit/blob URL なら commit ナビへ橋渡しして true。
 * そうでなければ false (呼び出し側が通常の外部ブラウザ起動にフォールバック)。
 */
async function routeCommitUrl(
    baseUri: vscode.Uri,
    href: string,
): Promise<boolean> {
    const cm = COMMIT_URL_RE.exec(href);
    if (cm) {
        await openCommitRef(baseUri, { kind: 'commit', ref: cm[1], href });
        return true;
    }
    const bm = BLOB_URL_RE.exec(href);
    if (bm) {
        await openCommitRef(baseUri, {
            kind: 'blob',
            ref: bm[1],
            file: decodeURIComponent(bm[2].split('#')[0]),
            href,
        });
        return true;
    }
    return false;
}

/** 表示中 URI が指している git rev を推定 (git: query / git-graph / 既定 HEAD)。 */
function currentRefFor(uri: vscode.Uri): string {
    return parseGitUri(uri)?.ref ?? decodeGitGraphUri(uri)?.ref ?? 'HEAD';
}

/** ヘッダー「⎇ Commit」: 表示中ファイルの commit をコミットブラウザで開く。 */
async function openCommitBrowserForCurrent(uri: vscode.Uri): Promise<void> {
    await openCommitRef(uri, { kind: 'commit', ref: currentRefFor(uri) });
}

/** 比較片側 URI の git ref。file: (作業ツリー) は undefined。 */
function refOfSide(uri: vscode.Uri): string | undefined {
    if (uri.scheme === 'file') return undefined;
    return parseGitUri(uri)?.ref ?? decodeGitGraphUri(uri)?.ref ?? 'HEAD';
}

/**
 * ヘッダー「⎇ Compare」(比較の右 pane のみ表示): 比較中の 2 ref を
 * git-commit-browser の ref 間比較で開く。custom-editor diff は editor/title の
 * when 句から確実に拾えない VSCode 制約があるため、rmd 側 (diff を diffPair で
 * 確実判定) のヘッダーから橋渡しする。片側 file: は ref 省略 = 作業ツリー比較。
 */
async function openCompareForPair(
    baseUri: vscode.Uri,
    originalUri: vscode.Uri,
    modifiedUri: vscode.Uri,
): Promise<void> {
    try {
        await vscode.commands.executeCommand(GIT_COMMIT_BROWSER_CMD, {
            kind: 'compare',
            refA: refOfSide(originalUri),
            refB: refOfSide(modifiedUri),
            uri: baseUri.toString(),
        });
    } catch {
        vscode.window.showWarningMessage(
            'Rendered Markdown Diff: Git Commit Browser 拡張が利用できません',
        );
    }
}

/**
 * tab タイトル等に出す basename。`git-graph:` URI の場合は path 部分が
 * `/file` (拡張子なし) になり得るので decode 後 filePath から取る (ContentRef 経由)。
 */
function displayBasename(uri: vscode.Uri): string {
    return ContentRef.from(uri).basename;
}
