import * as path from 'node:path';
import * as vscode from 'vscode';
import {
    type CommitDetail,
    type CommitFileChange,
    commitExists,
    findChildCommit,
    getCommitDetail,
    getDiffFiles,
    getRemoteCommitUrl,
    resolveGitContext,
} from '../../shared/src/git.js';
import { gitRefUri, parseGitUri } from '../../shared/src/gitApi.js';
import { decodeGitGraphUri } from '../../shared/src/gitGraphUri.js';

type OpenArgs =
    | {
          kind: 'commit';
          ref: string;
          uri?: string;
          href?: string;
          /** 子コミット探索の tip。HEAD に繋がらないブランチ用のヒント */
          branch?: string;
      }
    | { kind: 'blob'; ref: string; file: string; uri?: string; href?: string }
    /** ref 間 (または ref ↔ 作業ツリー) 比較。side 省略 = 作業ツリー */
    | { kind: 'compare'; refA?: string; refB?: string; uri?: string };

/** 追加/削除 diff の「無い側」用の空コンテンツ scheme (extension.ts で登録)。 */
export const EMPTY_SCHEME = 'gcb-empty';

/** 空コンテンツ側 URI。タイトルに元ファイル名を出す (拡張子は付けない)。 */
function emptyUri(name: string): vscode.Uri {
    return vscode.Uri.parse(`${EMPTY_SCHEME}:/${encodeURIComponent(name)}`);
}

/** command `xxxaz.git-commit-browser.open` のエントリ。 */
export async function openCommit(args: OpenArgs): Promise<void> {
    if (!args || typeof args.kind !== 'string') return;
    const baseUri = pickBaseUri(args.uri);
    try {
        if (args.kind === 'blob') {
            if (typeof args.ref === 'string')
                await openBlob(baseUri, args.file, args.ref, args.href);
        } else if (args.kind === 'compare') {
            await openCompareBrowser(baseUri, args.refA, args.refB);
        } else if (typeof args.ref === 'string') {
            await openCommitBrowser(baseUri, args.ref, args.href, args.branch);
        }
    } catch (err) {
        vscode.window.showWarningMessage(
            `Git Commit Browser: ${err instanceof Error ? err.message : String(err)}`,
        );
    }
}

/** 参照元ドキュメントの URI。無ければアクティブエディタを使う。 */
function pickBaseUri(uriStr: string | undefined): vscode.Uri | undefined {
    if (uriStr) {
        try {
            return vscode.Uri.parse(uriStr);
        } catch {
            /* fallthrough */
        }
    }
    return vscode.window.activeTextEditor?.document.uri;
}

/**
 * repo root を解決する。`baseUri`(参照元文書) のパスから辿るのが第一だが、
 * その文書が repo 外 (`/file.ts` 等の scratch) のことがあるので、解決できなければ
 * **ワークスペースフォルダ**から辿る。これで「リポジトリ外のファイルで SHA を
 * クリックすると失敗 (ファイルによって出たり出なかったり)」を解消する。
 */
async function resolveRepoRoot(
    baseUri: vscode.Uri | undefined,
): Promise<string | undefined> {
    if (baseUri) {
        const r = (await resolveGitContext(baseUri.fsPath))?.gitRoot;
        if (r) return r;
    }
    for (const f of vscode.workspace.workspaceFolders ?? []) {
        const r = (await resolveGitContext(f.uri.fsPath))?.gitRoot;
        if (r) return r;
    }
    return undefined;
}

/**
 * repo 相対 `relPath` の `ref` 時点を指す `git:` URI を作る (同期)。
 *
 * 共有層 `gitRefUri` 経由 = 組込み `vscode.git` の `toGitUri`。md / 非 md 一律。
 * md の `git:` も rendered-markdown-diff が描画 diff に結合できる。git-graph 形式を
 * 自前 mint しない (Git Graph 拡張の私的形式へ結合しない)。
 */
function refUri(repo: string, relPath: string, ref: string): vscode.Uri {
    return gitRefUri(path.join(repo, relPath), ref);
}

/**
 * repo に ref が実在すれば repo root を返す。無ければ fallbackHref で外部
 * ブラウザへ逃がし (無ければ警告)、undefined を返す。
 */
async function ensureLocalCommit(
    repo: string | undefined,
    ref: string,
    fallbackHref: string | undefined,
): Promise<string | undefined> {
    if (repo && (await commitExists(repo, ref))) return repo;
    if (fallbackHref) {
        await vscode.env.openExternal(vscode.Uri.parse(fallbackHref));
    } else {
        vscode.window.showWarningMessage(
            `Git Commit Browser: commit ${ref} はローカル repo に見つかりませんでした`,
        );
    }
    return undefined;
}

/**
 * GitHub/GitLab の blob URL (コミット＋ファイル両方を指定) を開く。
 * その特定ファイルの ref 時点を直接開く。
 */
async function openBlob(
    baseUri: vscode.Uri | undefined,
    file: string,
    ref: string,
    href: string | undefined,
): Promise<void> {
    const repo0 = await resolveRepoRoot(baseUri);
    const repo = await ensureLocalCommit(repo0, ref, href);
    if (!repo) return;
    await vscode.commands.executeCommand(
        'vscode.open',
        refUri(repo, file, ref),
        { viewColumn: vscode.ViewColumn.Active, preview: true },
    );
}

type CommitQuickItem = vscode.QuickPickItem & {
    act?: 'file';
    file?: CommitFileChange;
};
type CommitNavButton = vscode.QuickInputButton & {
    dir: 'parent' | 'child' | 'toggle-view' | 'github' | 'close' | 'info';
};

// 変更ファイル一覧の表示形式。デフォルトはツリー (ディレクトリ別)。
// セッション内でトグル状態を保持する。
let treeView = true;

// status 別の codicon。QuickPick ラベルは任意色を付けられない (API 制約) ため、
// せめて status ごとに別アイコンで視認性を上げる (テーマによっては色も付く)。
function statusIcon(status: string): string {
    switch (status[0]) {
        case 'A':
            return 'diff-added';
        case 'M':
            return 'diff-modified';
        case 'D':
            return 'diff-removed';
        case 'R':
        case 'C':
            return 'diff-renamed';
        default:
            return 'diff';
    }
}

/**
 * 変更ファイル 1 件を QuickPick 項目に。status で別アイコン、`baseRel`
 * (参照元ファイル) と一致するものは注記でハイライトする。
 */
function fileItem(
    f: CommitFileChange,
    label: string,
    baseRel: string | undefined,
): CommitQuickItem {
    const isBase = !!baseRel && f.path === baseRel;
    return {
        label: `$(${statusIcon(f.status)}) ${label}`,
        description: isBase ? `${f.status} ・ ⟵ この参照元` : f.status,
        act: 'file',
        file: f,
    };
}

/** 変更ファイル群を現在の表示形式 (flat/tree) の QuickPick 項目列にする。 */
function buildFileItems(
    files: CommitFileChange[],
    baseRel: string | undefined,
): CommitQuickItem[] {
    if (!treeView) {
        return files.map((f) => fileItem(f, f.path, baseRel));
    }
    const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path));
    const items: CommitQuickItem[] = [];
    let curDir: string | undefined;
    for (const f of sorted) {
        const dir = path.posix.dirname(f.path);
        const dirLabel = dir === '.' ? '(リポジトリ直下)' : `${dir}/`;
        if (dir !== curDir) {
            curDir = dir;
            items.push({
                label: dirLabel,
                kind: vscode.QuickPickItemKind.Separator,
            });
        }
        items.push(fileItem(f, path.posix.basename(f.path), baseRel));
    }
    return items;
}

/**
 * コミットブラウザ QuickPick。
 *   - そのコミットで変更された全ファイルを status 別アイコンで一覧
 *     (選択 = 親 commit ↔ 該当 commit の diff。A は左空 / D は右空)
 *   - 既定ツリー表示。参照元ファイルは注記ハイライト
 *   - タイトルバー: ← 親 / → 子 (branch/HEAD/含有 ref) / $(info) メッセージ全文 /
 *     $(list-tree|list-flat) 表示切替 / $(github) リモート / $(close) 閉じる
 *   - ファイルを開いてもフォーカスは QuickPick に残す (連続閲覧)
 */
async function openCommitBrowser(
    baseUri: vscode.Uri | undefined,
    ref: string,
    href: string | undefined,
    branch: string | undefined,
): Promise<void> {
    const repo0 = await resolveRepoRoot(baseUri);
    const repo = await ensureLocalCommit(repo0, ref, href);
    if (!repo) return;

    // 参照元ファイルの repo 相対パス。一覧中で該当ファイルをハイライトする用。
    const baseRel =
        baseUri && baseUri.scheme === 'file'
            ? (await resolveGitContext(baseUri.fsPath))?.relativePath
            : undefined;

    const qp = vscode.window.createQuickPick<CommitQuickItem>();
    qp.ignoreFocusOut = true;
    qp.matchOnDescription = true;
    const parentBtn: CommitNavButton = {
        dir: 'parent',
        iconPath: new vscode.ThemeIcon('arrow-left'),
        tooltip: '親コミット (sha^) へ',
    };
    const childBtn: CommitNavButton = {
        dir: 'child',
        iconPath: new vscode.ThemeIcon('arrow-right'),
        tooltip: '子コミットへ (branch / HEAD / 含有 ref を辿る)',
    };
    const toggleBtn = (): CommitNavButton => ({
        dir: 'toggle-view',
        iconPath: new vscode.ThemeIcon(treeView ? 'list-flat' : 'list-tree'),
        tooltip: treeView
            ? 'フラット表示に切替'
            : 'ツリー表示 (ディレクトリ別) に切替',
    });
    const githubBtn: CommitNavButton = {
        dir: 'github',
        iconPath: new vscode.ThemeIcon('github'),
        tooltip: 'このコミットをリモート (GitHub 等) で開く',
    };
    const closeBtn: CommitNavButton = {
        dir: 'close',
        iconPath: new vscode.ThemeIcon('close'),
        tooltip: '閉じる',
    };

    let detail: CommitDetail | undefined;

    // タイトルにはフルメッセージを出せない (QuickPick の制約) ので、$(info)
    // ボタンの hover tooltip にコミットメッセージ全文を出す (クリックでも表示)。
    const infoBtn = (): CommitNavButton => ({
        dir: 'info',
        iconPath: new vscode.ThemeIcon('info'),
        tooltip: detail?.body || 'コミットメッセージ',
    });

    // detail (取得済み) から QuickPick を再描画。git は叩かない (表示切替で使う)。
    const rerender = (): void => {
        if (!detail) return;
        const d = detail;
        qp.title = `${d.shortSha}  ${d.subject}`;
        qp.placeholder = `${d.author} ・ ${d.date} ・ ${d.files.length} files changed`;
        qp.buttons = [
            parentBtn,
            childBtn,
            infoBtn(),
            toggleBtn(),
            githubBtn,
            closeBtn,
        ];
        qp.items = [
            {
                label: `このコミットで変更されたファイル (${d.files.length})${
                    treeView ? ' — ツリー' : ''
                }`,
                kind: vscode.QuickPickItemKind.Separator,
            },
            ...buildFileItems(d.files, baseRel),
        ];
    };

    const load = async (sha: string): Promise<void> => {
        qp.busy = true;
        detail = await getCommitDetail(repo, sha);
        if (!detail) {
            qp.busy = false;
            qp.title = `commit ${sha} を解決できません`;
            qp.items = [];
            return;
        }
        rerender();
        qp.busy = false;
    };

    qp.onDidTriggerButton(async (btn) => {
        const b = btn as CommitNavButton;
        if (b.dir === 'close') {
            qp.hide();
            return;
        }
        if (b.dir === 'toggle-view') {
            treeView = !treeView;
            rerender();
            return;
        }
        if (!detail) return;
        if (b.dir === 'info') {
            vscode.window.showInformationMessage(detail.body, { modal: true });
            return;
        }
        if (b.dir === 'github') {
            const url = await getRemoteCommitUrl(repo, detail.sha);
            if (!url) {
                vscode.window.showInformationMessage(
                    'origin リモート URL を解決できませんでした',
                );
                return;
            }
            await vscode.env.openExternal(vscode.Uri.parse(url));
            return;
        }
        if (b.dir === 'parent') {
            if (detail.parents.length === 0) {
                vscode.window.showInformationMessage(
                    'これは最初のコミットです (親なし)',
                );
                return;
            }
            await load(detail.parents[0]);
            return;
        }
        if (b.dir === 'child') {
            const child = await findChildCommit(repo, detail.sha, branch);
            if (!child) {
                vscode.window.showInformationMessage(
                    '子コミットが見つかりません (HEAD 上にこのコミットの子が無い)',
                );
                return;
            }
            await load(child);
        }
    });

    qp.onDidAccept(async () => {
        const sel = qp.selectedItems[0];
        if (!sel || !detail) return;
        try {
            if (sel.act === 'file' && sel.file) {
                await openCommitFileChange(repo, detail, sel.file);
            }
        } catch (err) {
            vscode.window.showWarningMessage(
                `Git Commit Browser: ${err instanceof Error ? err.message : String(err)}`,
            );
        }
        // 連続探索のため閉じない (Esc で閉じる)
    });

    qp.onDidHide(() => qp.dispose());
    qp.show();
    await load(ref);
}

/**
 * 選択した変更ファイルを **前コミット (親) との diff** で開く。
 *   - 追加 (A) / 最初の commit: 親側を空にした diff (全行追加表示)
 *   - 削除 (D): この commit 側を空にした diff (全行削除表示)
 *   - それ以外 (M/R/C): 親 commit 版 (左) ↔ この commit 版 (右)
 * 追加/削除側を `git:` の存在しない ref:path にすると vscode.git が
 * FileNotFound を投げるので、欠側は空 provider (`gcb-empty:`) を使う。
 * `preserveFocus` でフォーカスはコミットブラウザに残す。
 */
async function openCommitFileChange(
    repo: string,
    detail: CommitDetail,
    file: CommitFileChange,
): Promise<void> {
    const parent = detail.parents[0];
    const s = file.status[0];
    const name = path.posix.basename(file.path);
    const left =
        s === 'A' || !parent
            ? emptyUri(name)
            : refUri(repo, file.oldPath ?? file.path, `${detail.sha}^`);
    const right =
        s === 'D' ? emptyUri(name) : refUri(repo, file.path, detail.sha);
    await vscode.commands.executeCommand(
        'vscode.diff',
        left,
        right,
        `${file.path} (${detail.shortSha}^ ↔ ${detail.shortSha}) [${file.status}]`,
        { preview: true, preserveFocus: true },
    );
}

function shortRef(ref: string): string {
    return /^[0-9a-f]{40}$/i.test(ref) ? ref.slice(0, 7) : ref;
}
function refLabel(ref: string | undefined): string {
    return ref ? shortRef(ref) : '作業ツリー';
}
/** 比較の片側 URI。ref 指定なら git: その ref、未指定なら作業ツリー file:。 */
function sideUri(
    repo: string,
    rel: string,
    ref: string | undefined,
): vscode.Uri {
    return ref
        ? gitRefUri(path.join(repo, rel), ref)
        : vscode.Uri.file(path.join(repo, rel));
}

/**
 * ref 間 (または ref ↔ 作業ツリー) の比較ブラウザ。差分のあるファイル一覧を
 * 出し、選択でそのファイルの git diff (左=refA / 右=refB or 作業ツリー) を開く。
 * 「作業ツリーと比較」は片側 ref 省略でこの機能として実現する。
 */
async function openCompareBrowser(
    baseUri: vscode.Uri | undefined,
    refA: string | undefined,
    refB: string | undefined,
): Promise<void> {
    if (!refA && !refB) {
        vscode.window.showInformationMessage(
            'Git Commit Browser: 比較する ref がありません',
        );
        return;
    }
    const repo = await resolveRepoRoot(baseUri);
    if (!repo) {
        vscode.window.showWarningMessage(
            'Git Commit Browser: git repo を解決できませんでした',
        );
        return;
    }
    // 左(old)=refA を必須化。refA 未指定なら「refB ↔ 作業ツリー」に正規化。
    const left = (refA ?? refB) as string;
    const right = refA ? refB : undefined;
    const baseRel =
        baseUri && baseUri.scheme === 'file'
            ? (await resolveGitContext(baseUri.fsPath))?.relativePath
            : undefined;

    const files = await getDiffFiles(repo, left, right);

    const qp = vscode.window.createQuickPick<CommitQuickItem>();
    qp.ignoreFocusOut = true;
    qp.matchOnDescription = true;
    const toggle = (): CommitNavButton => ({
        dir: 'toggle-view',
        iconPath: new vscode.ThemeIcon(treeView ? 'list-flat' : 'list-tree'),
        tooltip: treeView ? 'フラット表示に切替' : 'ツリー表示に切替',
    });
    const closeB: CommitNavButton = {
        dir: 'close',
        iconPath: new vscode.ThemeIcon('close'),
        tooltip: '閉じる',
    };
    const rerender = (): void => {
        qp.title = `${refLabel(left)} ↔ ${refLabel(right)}`;
        qp.placeholder = `${files.length} files differ`;
        qp.buttons = [toggle(), closeB];
        qp.items = [
            {
                label: `差分のあるファイル (${files.length})${
                    treeView ? ' — ツリー' : ''
                }`,
                kind: vscode.QuickPickItemKind.Separator,
            },
            ...buildFileItems(files, baseRel),
        ];
    };
    qp.onDidTriggerButton((btn) => {
        const b = btn as CommitNavButton;
        if (b.dir === 'close') {
            qp.hide();
            return;
        }
        if (b.dir === 'toggle-view') {
            treeView = !treeView;
            rerender();
        }
    });
    qp.onDidAccept(async () => {
        const sel = qp.selectedItems[0];
        if (!sel || sel.act !== 'file' || !sel.file) return;
        try {
            const f = sel.file;
            const name = path.posix.basename(f.path);
            const s = f.status[0];
            const origUri =
                s === 'A'
                    ? emptyUri(name)
                    : sideUri(repo, f.oldPath ?? f.path, left);
            const modUri =
                s === 'D' ? emptyUri(name) : sideUri(repo, f.path, right);
            await vscode.commands.executeCommand(
                'vscode.diff',
                origUri,
                modUri,
                `${f.path} (${refLabel(left)} ↔ ${refLabel(right)}) [${f.status}]`,
                { preview: true, preserveFocus: true },
            );
        } catch (err) {
            vscode.window.showWarningMessage(
                `Git Commit Browser: ${err instanceof Error ? err.message : String(err)}`,
            );
        }
    });
    qp.onDidHide(() => qp.dispose());
    rerender();
    qp.show();
}

/** 比較片側 URI の git ref。file: (作業ツリー) は undefined。 */
function refOfUri(uri: vscode.Uri): string | undefined {
    if (uri.scheme === 'file') return undefined;
    return parseGitUri(uri)?.ref ?? decodeGitGraphUri(uri)?.ref ?? undefined;
}

/** repo 解決用の実パス基準 URI を片側から得る。 */
function repoBaseOf(uris: vscode.Uri[]): vscode.Uri | undefined {
    for (const u of uris) {
        if (u.scheme === 'file') return u;
        const g = parseGitUri(u);
        if (g) return vscode.Uri.file(g.fsPath);
        const gg = decodeGitGraphUri(u);
        if (gg?.repo) return vscode.Uri.file(path.join(gg.repo, gg.filePath));
    }
    return undefined;
}

/**
 * いまアクティブな **diff (比較) エディタ** の左右 URI から ref 間比較ブラウザを
 * 開く。ファイル種別を問わず、editor/title (タブ右) ボタンから起動する用。
 * 片側が file: なら作業ツリー扱い (ref 省略) になる。
 */
export async function compareActiveDiffEditor(): Promise<void> {
    const input = vscode.window.tabGroups.activeTabGroup?.activeTab?.input;
    if (!(input instanceof vscode.TabInputTextDiff)) {
        vscode.window.showInformationMessage(
            'Git Commit Browser: 比較 (diff) エディタをアクティブにして実行してください',
        );
        return;
    }
    await openCompareBrowser(
        repoBaseOf([input.original, input.modified]),
        refOfUri(input.original),
        refOfUri(input.modified),
    );
}
