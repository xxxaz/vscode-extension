import { existsSync } from 'node:fs';
import * as vscode from 'vscode';
import { ContentRef } from '../../shared/src/contentRef.js';

/**
 * ソースコードのコメント / 文字列リテラル等に出てくる **ファイルパス**を
 * クリック可能にする `DocumentLinkProvider`。
 *
 * 解決は共有 `ContentRef.resolveRelative()` に委譲する。これにより:
 *   - `file:` ドキュメント       → 作業ツリーの対象ファイル
 *   - `git:` / `gitfs:` (ある ref を表示中) → **同じ ref** の対象ファイル
 *   - `git-graph:` (ある commit) → 同じ commit の対象ファイル
 * が自動で選ばれる (= git ファイルとして開いている時は同 ref の対象を開く)。
 *
 * 誤検出を抑えるため「`/` を含み拡張子で終わる」または `./` `../` 始まりの
 * トークンだけを対象にし、URL 内のパスは除外する。
 */
// 例: src/a/b.ts, ./x.json, ../util/y.tsx, docs/readme.md
const PATH_RE = /(?:\.\.?\/)?(?:[\w.@-]+\/)+[\w.@-]+\.[A-Za-z][\w]{0,11}/g;
const URL_RE = /\b[a-z][\w+.-]*:\/\/[^\s)<>"']+/gi;

const MAX_TEXT = 2 * 1024 * 1024;
const MAX_LINKS = 500;

export class PathLinkProvider implements vscode.DocumentLinkProvider {
    provideDocumentLinks(
        document: vscode.TextDocument,
        token: vscode.CancellationToken,
    ): vscode.DocumentLink[] {
        const text = document.getText();
        if (text.length > MAX_TEXT) return [];

        // URL 内のパス片を拾わないよう URL 範囲を覚えておく
        const urlRanges: Array<[number, number]> = [];
        for (const m of text.matchAll(URL_RE)) {
            const s = m.index ?? 0;
            urlRanges.push([s, s + m[0].length]);
        }
        const inUrl = (s: number, e: number): boolean =>
            urlRanges.some(([us, ue]) => s < ue && us < e);

        const base = ContentRef.from(document.uri);
        const links: vscode.DocumentLink[] = [];
        for (const m of text.matchAll(PATH_RE)) {
            if (token.isCancellationRequested) break;
            if (links.length >= MAX_LINKS) break;
            const start = m.index ?? 0;
            const end = start + m[0].length;
            if (inUrl(start, end)) continue;

            const target = base.resolveRelative(m[0])?.uri;
            if (!target) continue;
            // 作業ツリー (file:) は実在するものだけ。ref 版は stat 不可なので
            // 楽観的にリンク化 (存在しなければ開いた先で空表示になるだけ)。
            if (target.scheme === 'file' && !existsSync(target.fsPath)) {
                continue;
            }
            const link = new vscode.DocumentLink(
                new vscode.Range(
                    document.positionAt(start),
                    document.positionAt(end),
                ),
                target,
            );
            link.tooltip =
                target.scheme === 'file'
                    ? 'ファイルを開く'
                    : 'このファイルを同じ ref で開く';
            links.push(link);
        }
        return links;
    }
}
