import * as path from 'node:path';
import * as vscode from 'vscode';
import { readFileAtRef, resolveGitContext } from './git.js';
import { gitRefUri, parseGitUri } from './gitApi.js';
import { decodeGitGraphUri } from './gitGraphUri.js';
import { decodeGitLensUri } from './gitLensUri.js';

/**
 * 「ある md ファイルの、ある git/fs 文脈での実体」を表す値オブジェクト。
 *
 * 概念は 2 つだけ:
 *   - 作業ツリー (`file:`)
 *   - **ある git rev のファイル** (それ以外すべて)
 *
 * rev は SHA / branch / tag / `HEAD^` 等の任意 git 参照。"commit" と "ref" を
 * 分けない (両者に意味論の差は無く、違うのは内容取得トランスポートだけ)。
 *
 * scheme 別トランスポート:
 *   - `file:`              → 作業ツリーを直接 read
 *   - `git:` / `gitfs:`    → VSCode 組込み git 拡張の FileSystemProvider
 *   - `gitlens:`           → 同上。空を返すことがあるので git CLI へフォールバック
 *   - `git-graph:`         → **Git Graph 拡張が渡してくる incoming 専用** (interop)。
 *                            provider が無いこともあるので git CLI で自前取得
 *
 * 「ファイル@rev」を新規に表現する時は git-graph 形式を mint せず、組込みの
 * `git:` URI (`gitRefUri`) を使う (`fromGitRef`)。git-graph URI の decode は
 * incoming を境界で 1 回するだけで、内部の正準表現にはしない。
 */
const REF_SCHEMES = ['git', 'gitfs', 'gitlens'];

/** incoming `git-graph:` を自前 read するためのパース済みメタ。 */
type GitRefMeta = { repo: string; filePath: string; rev: string };

export class ContentRef {
    /**
     * `meta` は incoming `git-graph:` を境界で 1 回だけ decode した結果。
     * 自前 git CLI read / 相対解決 / 表示に使い、以降 URI を decode し直さない。
     * 自前 mint した `git:` は provider が内容を返すので `meta` は持たない。
     */
    private constructor(
        readonly uri: vscode.Uri,
        private readonly meta?: GitRefMeta,
    ) {}

    static from(uri: vscode.Uri): ContentRef {
        if (uri.scheme === 'git-graph') {
            const gg = decodeGitGraphUri(uri);
            if (gg?.repo) {
                return new ContentRef(uri, {
                    repo: gg.repo,
                    filePath: gg.filePath,
                    rev: gg.ref,
                });
            }
        }
        return new ContentRef(uri);
    }

    /**
     * repo 相対ファイルの ある git rev 時点 を表す ContentRef。
     * 組込み git 拡張の `git:` URI を生成 (provider が内容を返す)。
     */
    static fromGitRef(repo: string, filePath: string, rev: string): ContentRef {
        return new ContentRef(gitRefUri(path.join(repo, filePath), rev));
    }

    get scheme(): string {
        return this.uri.scheme;
    }

    /** タブ名等に出す basename。 */
    get basename(): string {
        if (this.meta) return path.posix.basename(this.meta.filePath);
        return path.basename(this.uri.path);
    }

    /** subtitle 等に出す説明文字列。 */
    describe(): string {
        if (this.uri.scheme === 'file') return this.uri.fsPath;
        if (this.meta) {
            const m = this.meta;
            return `${m.repo}/${m.filePath} @ ${m.rev}`;
        }
        const g = parseGitUri(this.uri);
        if (g) return `${g.fsPath} @ ${g.ref}`;
        return this.uri.toString();
    }

    async read(): Promise<string | undefined> {
        const u = this.uri;
        if (u.scheme === 'file' || REF_SCHEMES.includes(u.scheme)) {
            let viaFs: string | undefined;
            try {
                const buf = await vscode.workspace.fs.readFile(u);
                viaFs = new TextDecoder('utf-8').decode(buf);
            } catch {
                viaFs = undefined;
            }
            if (viaFs !== undefined && viaFs.length > 0) return viaFs;
            // gitlens: は FileSystemProvider が内容を返さず比較ビューワーが
            // 空になることがある。git CLI で取り直す。
            if (u.scheme === 'gitlens') {
                const fb = await readGitLensViaGit(u);
                if (fb !== undefined) return fb;
            }
            return viaFs;
        }
        // incoming git-graph: は provider が無いこともあるので git CLI で自前取得
        if (this.meta) {
            const m = this.meta;
            return readFileAtRef(m.repo, m.filePath, m.rev);
        }
        // 未知スキーム (Claude Code の編集差分 `_claude_vscode_fs_*:` 等、別拡張が
        // FileSystemProvider / TextDocumentContentProvider を登録しているもの) は
        // openTextDocument で内容が取れる。これで差分プレビュー右側の
        // 「内容取得失敗」を解消する。
        try {
            const doc = await vscode.workspace.openTextDocument(u);
            return doc.getText();
        } catch {
            return undefined;
        }
    }

    /** 対応する作業ツリー file: の ContentRef。導出不能なら undefined。 */
    toWorktree(): ContentRef | undefined {
        const u = this.uri;
        if (u.scheme === 'file') return this;
        if (this.meta) {
            const m = this.meta;
            return new ContentRef(
                vscode.Uri.file(path.join(m.repo, m.filePath)),
            );
        }
        if (REF_SCHEMES.includes(u.scheme)) {
            // git: の query に実パスがある場合はそれを優先 (path だけだと不正確)。
            const g = parseGitUri(u);
            if (g) return new ContentRef(vscode.Uri.file(g.fsPath));
            // gitlens: 等は path が実ファイルパスなので scheme を file に差替え
            // (実在しない場合は呼び出し側の stat チェックで弾かれる)
            return new ContentRef(
                u.with({ scheme: 'file', query: '', fragment: '' }),
            );
        }
        return undefined;
    }

    /**
     * 同じ rev 文脈で相対 / 絶対パス href を解決した ContentRef。
     * `#fragment` は preserve。scheme 未対応時 undefined。
     */
    resolveRelative(href: string): ContentRef | undefined {
        const hashIdx = href.indexOf('#');
        const pathPart = hashIdx >= 0 ? href.substring(0, hashIdx) : href;
        const fragment = hashIdx >= 0 ? href.substring(hashIdx + 1) : '';
        let decodedPath: string;
        try {
            decodedPath = decodeURI(pathPart);
        } catch {
            decodedPath = pathPart;
        }
        const u = this.uri;
        if (u.scheme === 'file') {
            const targetPath = path.resolve(
                path.dirname(u.fsPath),
                decodedPath,
            );
            return new ContentRef(
                vscode.Uri.file(targetPath).with({ fragment }),
            );
        }
        // incoming git-graph: の相対リンク → 同 rev の別ファイルを git: で開く
        if (this.meta) {
            const m = this.meta;
            const baseDir = path.posix.dirname(m.filePath);
            const targetRel = path.posix.normalize(
                path.posix.join(baseDir, decodedPath.replace(/\\/g, '/')),
            );
            return new ContentRef(
                ContentRef.fromGitRef(m.repo, targetRel, m.rev).uri.with({
                    fragment,
                }),
            );
        }
        if (REF_SCHEMES.includes(u.scheme)) {
            // git: は query 内 fsPath を基準に同 rev の別ファイルを正しく再生成
            // (uri.path だけ差し替えると query.path が古いままになる既知の罠)
            const g = parseGitUri(u);
            if (g) {
                const targetFs = path.resolve(
                    path.dirname(g.fsPath),
                    decodedPath,
                );
                return new ContentRef(
                    gitRefUri(targetFs, g.ref).with({ fragment }),
                );
            }
            // gitlens: / query 無し → best-effort で path を差し替え
            const baseDir = path.posix.dirname(u.path);
            const targetPath = path.posix.normalize(
                path.posix.join(baseDir, decodedPath.replace(/\\/g, '/')),
            );
            return new ContentRef(u.with({ path: targetPath, fragment }));
        }
        return undefined;
    }

    /** この ref が属する git repo root。解決できなければ undefined。 */
    async gitRepoRoot(): Promise<string | undefined> {
        if (this.meta) return this.meta.repo;
        const u = this.uri;
        const g = parseGitUri(u);
        if (g) return (await resolveGitContext(g.fsPath))?.gitRoot;
        if (u.scheme === 'file' || REF_SCHEMES.includes(u.scheme)) {
            return (await resolveGitContext(u.fsPath))?.gitRoot;
        }
        return undefined;
    }
}

/**
 * `gitlens:` URI を decode し、git CLI (`readFileAtRef`) で同じ ref のファイル
 * 内容を取り直す。GitLens の FileSystemProvider が内容を返さず比較ビューワーが
 * 空になるケースのフォールバック。decode 不能 / repo 解決不能なら undefined。
 */
async function readGitLensViaGit(uri: vscode.Uri): Promise<string | undefined> {
    const d = decodeGitLensUri(uri);
    if (!d) return undefined;
    let repo = d.repo;
    let rel = d.filePath;
    if (path.isAbsolute(rel)) {
        if (repo) {
            rel = path.relative(repo, rel).split(path.sep).join('/');
        } else {
            const ctx = await resolveGitContext(rel);
            if (!ctx) return undefined;
            repo = ctx.gitRoot;
            rel = ctx.relativePath;
        }
    } else if (!repo) {
        // 相対パスだが repo が分からない → 解決不能
        return undefined;
    }
    return readFileAtRef(repo, rel, d.ref);
}
