import * as vscode from 'vscode';

/**
 * VSCode 組込み git 拡張 (`vscode.git`) の `toGitUri` を共有するための薄い層。
 *
 * `toGitUri(uri, ref)` は同期関数だが、その関数を持つ API オブジェクトの取得は
 * 拡張 activate を要して非同期。`ContentRef.resolveRelative()` 等の同期経路から
 * 使いたいので、各拡張の activate で一度 `initGitApi()` し、以降は同期の
 * `gitRefUri()` を使う。未注入時は同形式を手組みするフォールバックを持つ。
 *
 * `git:` URI 形式 (vscode.git): `git:<path>?{"path":"<fsPath>","ref":"<ref>"}`。
 * FileSystemProvider はこの query を読んで内容を返すだけで状態を持たない
 * (= URI が自己記述)。
 */
/**
 * git ref を指すロケータの共通形。`decodeGitGraphUri` / `decodeGitLensUri` の
 * 返り値はこの形にそろえる。
 *   - `repo`: git-graph では常に入る。gitlens では取れないこともあるので optional
 *   - `filePath`: repo 相対 or 絶対 (decoder 依存。consumer 側で吸収)
 *   - `ref`: rev (SHA / branch / tag / `HEAD^` 等)。"commit" と区別しない
 */
export type GitRefLocator = {
    repo?: string;
    filePath: string;
    ref: string;
};

type ToGitUri = (uri: vscode.Uri, ref: string) => vscode.Uri;

let injected: ToGitUri | undefined;

/** 既に解決済みの toGitUri を直接注入する (テスト等)。 */
export function setToGitUri(fn: ToGitUri): void {
    injected = fn;
}

/**
 * `vscode.git` を activate して `toGitUri` を取り込む。各拡張の activate から
 * `void initGitApi()` で呼ぶ (失敗しても手組みフォールバックがあるので致命でない)。
 */
export async function initGitApi(): Promise<void> {
    const ext = vscode.extensions.getExtension('vscode.git');
    if (!ext) return;
    if (!ext.isActive) {
        try {
            await ext.activate();
        } catch {
            return;
        }
    }
    const api = (
        ext.exports as { getAPI?: (v: number) => unknown } | undefined
    )?.getAPI?.(1) as { toGitUri?: ToGitUri } | undefined;
    if (api?.toGitUri) injected = api.toGitUri;
}

/**
 * 絶対パス `fsPath` の `ref` 時点を指す `git:` URI を作る (同期)。
 * 注入済みなら公式 `toGitUri`、未注入時のみ同形式を手組み。
 */
export function gitRefUri(fsPath: string, ref: string): vscode.Uri {
    const fileUri = vscode.Uri.file(fsPath);
    if (injected) return injected(fileUri, ref);
    return fileUri.with({
        scheme: 'git',
        query: JSON.stringify({ path: fsPath, ref }),
    });
}

/**
 * `git:` / `gitfs:` URI の query から `{ fsPath, ref }` を取り出す。
 * vscode.git 形式 (`{"path","ref"}`) を JSON.parse するだけ。解釈できなければ undefined。
 */
export function parseGitUri(
    uri: vscode.Uri,
): { fsPath: string; ref: string } | undefined {
    if (uri.scheme !== 'git' && uri.scheme !== 'gitfs') return undefined;
    if (!uri.query) return undefined;
    try {
        const q = JSON.parse(uri.query) as { path?: unknown; ref?: unknown };
        if (typeof q.path === 'string' && typeof q.ref === 'string') {
            return { fsPath: q.path, ref: q.ref };
        }
    } catch {
        // not JSON / 未知形式
    }
    return undefined;
}
