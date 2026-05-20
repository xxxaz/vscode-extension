import type * as vscode from 'vscode';
import type { GitRefLocator } from './gitApi.js';

/**
 * GitLens (`gitlens:` scheme) の URI から `GitRefLocator` ({repo?,filePath,ref})
 * を best-effort で取り出す。GitLens は版によって query の持ち方が異なる
 * (生 JSON / percent-encoded JSON / base64 JSON) ため順に試す。
 *
 * GitLens の代表的フィールド: `ref` または `sha`、`path` または `fileName`、`repoPath`。
 * ref と path が取れなければ undefined (= フォールバック不能)。
 *
 * これは GitLens の FileSystemProvider が内容を返さず比較ビューワーが空になる事象
 * (`gitlens:` → `git:` 相当へのフォールバック) のために使う。
 */
export function decodeGitLensUri(uri: vscode.Uri): GitRefLocator | undefined {
    if (uri.scheme !== 'gitlens') return undefined;
    const q = uri.query;

    const tryJson = (s: string): Record<string, unknown> | undefined => {
        try {
            const v = JSON.parse(s);
            return v && typeof v === 'object'
                ? (v as Record<string, unknown>)
                : undefined;
        } catch {
            return undefined;
        }
    };

    let data: Record<string, unknown> | undefined;
    if (q) {
        let decoded = q;
        try {
            decoded = decodeURIComponent(q);
        } catch {
            decoded = q;
        }
        data = tryJson(q) ?? tryJson(decoded);
        if (!data) {
            try {
                data = tryJson(
                    Buffer.from(decoded, 'base64').toString('utf-8'),
                );
            } catch {
                data = undefined;
            }
        }
    }

    const str = (v: unknown): string | undefined =>
        typeof v === 'string' && v.length > 0 ? v : undefined;

    const ref = str(data?.ref) ?? str(data?.sha);
    const filePath = str(data?.path) ?? str(data?.fileName) ?? str(uri.fsPath);
    const repo = str(data?.repoPath);
    if (!ref || !filePath) return undefined;
    return { repo, filePath, ref };
}
