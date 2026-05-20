import type * as vscode from 'vscode';
import type { GitRefLocator } from './gitApi.js';

/**
 * Git Graph 拡張が使う `git-graph:/file.md?<base64({filePath,commit,repo,exists})>`
 * URI を decode し、共通の `GitRefLocator` ({repo,filePath,ref}) で返す。
 * Git Graph 由来でなければ undefined。`exists` は consumer が使わないので落とす。
 */
export function decodeGitGraphUri(uri: vscode.Uri): GitRefLocator | undefined {
    if (uri.scheme !== 'git-graph') return undefined;
    if (!uri.query) return undefined;
    try {
        const json = Buffer.from(
            decodeURIComponent(uri.query),
            'base64',
        ).toString('utf-8');
        const data = JSON.parse(json) as {
            filePath?: string;
            commit?: string;
            repo?: string;
        };
        if (!data.filePath || !data.commit || !data.repo) return undefined;
        return {
            repo: data.repo,
            filePath: data.filePath,
            ref: data.commit,
        };
    } catch {
        return undefined;
    }
}
