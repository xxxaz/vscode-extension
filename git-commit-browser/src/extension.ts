import * as vscode from 'vscode';
import { initGitApi } from '../../shared/src/gitApi.js';
import {
    compareActiveDiffEditor,
    EMPTY_SCHEME,
    openCommit,
} from './commitBrowser.js';
import { CommitLinkProvider } from './commitLinkProvider.js';
import { PathLinkProvider } from './pathLinkProvider.js';

/**
 * Git Commit Browser 拡張。
 *
 * markdown レンダリングから独立した汎用のコミット参照ナビゲータ。任意のテキスト
 * エディタ (ソースコードのコメント / 生 md / 設定ファイル等) に出てくる
 *   - bare SHA (リポジトリに実在するもののみ。GitHub 同様 verify-before-link)
 *   - GitHub/GitLab の commit URL / blob URL
 * を `DocumentLinkProvider` でクリック可能にし、コミットブラウザ QuickPick
 * (変更ファイル一覧 / 前後コミット) を開く。
 *
 * git 取得・URI 解決ロジックは `../../shared` (rendered-markdown-diff と共用)。
 */
export function activate(context: vscode.ExtensionContext): void {
    // 組込み git 拡張の toGitUri を共有層へ注入 (refUri の同期生成で使う)。
    void initGitApi();

    context.subscriptions.push(
        vscode.languages.registerDocumentLinkProvider(
            [{ scheme: 'file' }, { scheme: 'untitled' }],
            new CommitLinkProvider(),
        ),
        // ソースコメント/文字列中のファイルパスをリンク化。git: 等 ref を表示中なら
        // 同じ ref の対象を開く (ContentRef.resolveRelative が文脈を保つ)。
        vscode.languages.registerDocumentLinkProvider(
            [
                { scheme: 'file' },
                { scheme: 'untitled' },
                { scheme: 'git' },
                { scheme: 'gitfs' },
            ],
            new PathLinkProvider(),
        ),
    );

    // 追加/削除ファイルの diff で「無い側」に出す空コンテンツ。vscode.git は
    // 存在しない ref:path で FileNotFound を投げるため、欠側はこの空 provider に。
    context.subscriptions.push(
        vscode.workspace.registerTextDocumentContentProvider(EMPTY_SCHEME, {
            provideTextDocumentContent: () => '',
        }),
    );

    context.subscriptions.push(
        vscode.commands.registerCommand(
            'xxxaz.git-commit-browser.open',
            (args) => openCommit(args),
        ),
        vscode.commands.registerCommand(
            'xxxaz.git-commit-browser.compareActiveDiff',
            () => compareActiveDiffEditor(),
        ),
    );
}

export function deactivate(): void {
    // no-op
}
