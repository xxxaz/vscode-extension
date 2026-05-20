import * as path from 'node:path';
import * as vscode from 'vscode';
import { initGitApi } from '../../shared/src/gitApi.js';
import { decodeGitGraphUri } from '../../shared/src/gitGraphUri.js';
import {
    RenderedMarkdownDiffProvider,
    registerRmdSourceProvider,
} from './viewerProvider.js';

let output: vscode.OutputChannel;

export function activate(context: vscode.ExtensionContext) {
    output = vscode.window.createOutputChannel('Rendered Markdown Diff');
    context.subscriptions.push(output);
    output.appendLine(`[activate] ${new Date().toISOString()}`);

    // 組込み git 拡張の toGitUri を共有層へ注入 (ContentRef の同期経路で使う)。
    // 失敗しても gitRefUri が同形式を手組みするので致命ではない。
    void initGitApi();

    // `*.md` のデフォルト custom editor (package.json `customEditors.priority="default"`)。
    // Explorer / Source Control / Git Graph 等から開かれる md はすべてここで描画される。
    // ユーザーが `workbench.editorAssociations` で `*.md` を別 viewType に上書きした場合は
    // VSCode が通常の text editor / preview にフォールバックする。
    // `rmd-source:` 仮想スキーム (ref 内容を read-only テキストで開く「</> Source」用)
    registerRmdSourceProvider(context);

    context.subscriptions.push(
        vscode.window.registerCustomEditorProvider(
            RenderedMarkdownDiffProvider.viewType,
            new RenderedMarkdownDiffProvider(context, output),
            {
                supportsMultipleEditorsPerDocument: true,
                webviewOptions: {
                    retainContextWhenHidden: false,
                    // Ctrl+F / Cmd+F で webview 組み込みの find widget を有効化。
                    // レンダリング後のテキストに対して検索できる
                    // (mermaid SVG 内のテキストは対象外)
                    enableFindWidget: true,
                },
            },
        ),
    );

    // 診断用 + Git Graph 用 URI 修正:
    //   - 開かれる tab の input 種別 / URI を Output Channel に流す
    //   - Git Graph の add/delete diff は片側が `git-graph:/file?...` (拡張子なし) で
    //     来るため `*.md` selector に当たらない。decode した filePath の basename に
    //     URI path を書き換えて vscode.diff し直すことで、両側 .md の TabInputTextDiff
    //     に整え、smart viewer に拾わせる
    context.subscriptions.push(
        vscode.window.tabGroups.onDidChangeTabs((event) => {
            for (const tab of event.opened) {
                const input = tab.input;
                const parts: string[] = [
                    `inputType=${input?.constructor?.name ?? 'null'}`,
                    `label=${JSON.stringify(tab.label)}`,
                ];
                if (input instanceof vscode.TabInputText) {
                    parts.push(`uri=${input.uri.toString()}`);
                } else if (input instanceof vscode.TabInputCustom) {
                    parts.push(`uri=${input.uri.toString()}`);
                    parts.push(`viewType=${input.viewType}`);
                } else if (input instanceof vscode.TabInputTextDiff) {
                    parts.push(`original=${input.original.toString()}`);
                    parts.push(`modified=${input.modified.toString()}`);
                }
                output.appendLine(`[tab opened] ${parts.join(' / ')}`);

                if (input instanceof vscode.TabInputTextDiff) {
                    fixGitGraphMissingSideDiff(tab, input).catch((err) => {
                        output.appendLine(
                            `[git-graph fixup] error: ${err instanceof Error ? err.message : String(err)}`,
                        );
                    });
                }
            }
        }),
    );

    // テキストエディタとして *.md を開いている時に、明示的に viewer に切替えるためのコマンド。
    // `workbench.action.reopenWithEditor` だと Quick Pick が出るが、我々の viewer に
    // 直接戻りたいケースが大半なので 1 アクションで完結させる。
    // package.json `contributes.menus.editor/title` でタブ右上にアイコン表示。
    context.subscriptions.push(
        vscode.commands.registerCommand(
            'xxxaz.rendered-markdown-diff.reopenAsViewer',
            async () => {
                const editor = vscode.window.activeTextEditor;
                if (!editor) return;
                const uri = editor.document.uri;
                const viewColumn = editor.viewColumn;
                // 新規タブではなく「同じ tab を viewer に切替え」たい。
                // openWith は別タブで開くことがあるため、dirty でなければ
                // アクティブな text editor を閉じてから同 column に viewer を開く。
                if (!editor.document.isDirty) {
                    await vscode.commands.executeCommand(
                        'workbench.action.closeActiveEditor',
                    );
                }
                await vscode.commands.executeCommand(
                    'vscode.openWith',
                    uri,
                    RenderedMarkdownDiffProvider.viewType,
                    viewColumn,
                );
            },
        ),
    );

    // viewer → text editor の逆方向。組み込み `workbench.action.reopenTextEditor` の
    // 薄いラッパー。`contributes.commands` で `icon` を持たせるためにこちらの
    // コマンド id 経由で editor/title に表示する。
    context.subscriptions.push(
        vscode.commands.registerCommand(
            'xxxaz.rendered-markdown-diff.reopenAsText',
            async () => {
                await vscode.commands.executeCommand(
                    'workbench.action.reopenTextEditor',
                );
            },
        ),
    );
}

export function deactivate(): void {
    // no-op
}

/**
 * `git-graph:` URI の path basename が、base64 query で decode した実 `filePath` の
 * basename と一致しない (= Git Graph が「ファイル無し側」を `/file` という拡張子
 * 抜きのプレースホルダで開いている) ケース。
 *
 * このまま VSCode に処理させると `*.md` selector に当たらず標準の text diff editor が
 * 開いてしまうので、片側 (場合によっては両側) の URI path を decode 後の basename に
 * 書き換え、`vscode.diff` で開き直して smart viewer に拾わせる。
 */
async function fixGitGraphMissingSideDiff(
    tab: vscode.Tab,
    input: vscode.TabInputTextDiff,
): Promise<void> {
    const origNeedsFix = isGitGraphMissingSide(input.original);
    const modNeedsFix = isGitGraphMissingSide(input.modified);
    if (!origNeedsFix && !modNeedsFix) return;

    const newOrig = origNeedsFix
        ? rewriteGitGraphPath(input.original)
        : input.original;
    const newMod = modNeedsFix
        ? rewriteGitGraphPath(input.modified)
        : input.modified;
    if (
        newOrig.toString() === input.original.toString() &&
        newMod.toString() === input.modified.toString()
    )
        return;

    const label = tab.label;
    await vscode.window.tabGroups.close(tab);
    await vscode.commands.executeCommand('vscode.diff', newOrig, newMod, label);
}

/**
 * `git-graph:` URI で path basename と decode 後 filePath basename が食い違う、
 * かつ実 filePath が `.md` を持つ場合のみ true。Dockerfile 等を巻き込まないよう
 * scope を絞り込む役割。
 */
function isGitGraphMissingSide(uri: vscode.Uri): boolean {
    if (uri.scheme !== 'git-graph') return false;
    const gg = decodeGitGraphUri(uri);
    if (!gg) return false;
    const expectedBasename = path.posix.basename(gg.filePath);
    if (!expectedBasename.toLowerCase().endsWith('.md')) return false;
    const actualBasename = path.posix.basename(uri.path);
    return actualBasename !== expectedBasename;
}

function rewriteGitGraphPath(uri: vscode.Uri): vscode.Uri {
    const gg = decodeGitGraphUri(uri);
    if (!gg) return uri;
    return uri.with({ path: `/${path.posix.basename(gg.filePath)}` });
}
