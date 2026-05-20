import { execFile } from 'node:child_process';
import { statSync } from 'node:fs';
import * as path from 'node:path';
import { promisify } from 'node:util';
import type * as vscode from 'vscode';

const execFileAsync = promisify(execFile);

/**
 * `fsPath` を含む **実在する最も近いディレクトリ**を返す (git 実行 cwd 用)。
 *
 *   - `fsPath` 自身が実在ディレクトリ → それ (ワークスペースフォルダ等)
 *   - 実在ファイル → その dirname
 *   - 実在しない (別 commit のファイル / scratch 等) → 実在する最も近い祖先
 *
 * 以前は常に `dirname(fsPath)` 始点だったため、ディレクトリパス
 * (ワークスペースフォルダ) を渡すと 1 つ上で git を実行し repo 解決が
 * 失敗していた (フォールバックが機能しないバグ)。
 */
function nearestExistingDir(fsPath: string): string {
    let d = fsPath;
    while (d !== path.dirname(d)) {
        try {
            return statSync(d).isDirectory() ? d : path.dirname(d);
        } catch {
            d = path.dirname(d);
        }
    }
    return d;
}

const GIT_MAX_BUFFER = 32 * 1024 * 1024;

// 非 ASCII パス (日本語ファイル名等) を git が `"\346..."` と8進エスケープ
// するのを抑止する。これを付けないと変更ファイル一覧 / toplevel パスが
// 文字化けし、URI 生成や表示が壊れる。全 git 呼び出しの先頭に置く。
const QUOTEPATH_OFF = ['-c', 'core.quotePath=false'];

/**
 * ref が argument injection に対して安全かを判定する。
 *
 * URL 由来 ref (GitHub blob URL の `<ref>` 等) は外部入力。先頭が `-` だと
 * git の各サブコマンドが option として誤解釈する余地がある (`--upload-pack=`
 * 系の悪用)。実用上の ref には先頭ハイフン・空白・シェルメタは現れないので、
 * defense-in-depth として一律拒否する。許可される形は概ね git の refname
 * 規約に沿う (実害想定が低いので過度に緩める必要なし)。
 *
 * 不正な ref を渡された ref-accepting 関数は `false` / `undefined` を返して
 * 何もしない方針。
 */
export function isSafeRef(ref: string): boolean {
    if (typeof ref !== 'string' || ref.length === 0) return false;
    if (ref.startsWith('-')) return false;
    // 制御文字 (ASCII 0x00-0x1F, 0x7F) は regex に書けない (biome 警告) ので
    // charCode で判定。空白・シェルメタ・git refname 不可文字は regex で。
    for (let i = 0; i < ref.length; i++) {
        const c = ref.charCodeAt(i);
        if (c < 0x20 || c === 0x7f) return false;
    }
    if (/[\s'"$`<>|;&\\?[\]*]/.test(ref)) return false;
    return true;
}

export type HeadLookup =
    | { kind: 'found'; content: string; relativePath: string; gitRoot: string }
    | { kind: 'not-in-head'; relativePath: string; gitRoot: string }
    | { kind: 'not-a-repo' };

/**
 * 対象 URI のファイルが HEAD で持っていた内容を返す。
 *
 * シェル展開を避けるため execFile + 引数配列で git を呼ぶ。
 */
export async function readFileAtHead(fileUri: vscode.Uri): Promise<HeadLookup> {
    const cwd = nearestExistingDir(fileUri.fsPath);
    let gitRoot: string;
    try {
        const result = await execFileAsync(
            'git',
            [...QUOTEPATH_OFF, 'rev-parse', '--show-toplevel'],
            { cwd },
        );
        gitRoot = result.stdout.trim();
    } catch {
        return { kind: 'not-a-repo' };
    }

    const relativePath = path
        .relative(gitRoot, fileUri.fsPath)
        .split(path.sep)
        .join('/');

    try {
        const { stdout } = await execFileAsync(
            'git',
            [...QUOTEPATH_OFF, 'show', `HEAD:${relativePath}`],
            {
                cwd: gitRoot,
                maxBuffer: GIT_MAX_BUFFER,
            },
        );
        return { kind: 'found', content: stdout, relativePath, gitRoot };
    } catch {
        // HEAD に存在しない (新規ファイル等)
        return { kind: 'not-in-head', relativePath, gitRoot };
    }
}

/**
 * file: の fsPath から git root と repo 相対パスを解決する。
 * commit 参照 / 作業ツリー導出のために `ContentRef` 側から使う。
 * git 管理外 / git 不在なら undefined。
 */
export async function resolveGitContext(
    fsPath: string,
): Promise<{ gitRoot: string; relativePath: string } | undefined> {
    try {
        const { stdout } = await execFileAsync(
            'git',
            [...QUOTEPATH_OFF, 'rev-parse', '--show-toplevel'],
            { cwd: nearestExistingDir(fsPath) },
        );
        const gitRoot = stdout.trim();
        if (!gitRoot) return undefined;
        const relativePath = path
            .relative(gitRoot, fsPath)
            .split(path.sep)
            .join('/');
        return { gitRoot, relativePath };
    } catch {
        return undefined;
    }
}

/**
 * 指定 ref が当該 repo 内に commit として存在するか。
 * GitHub/GitLab の commit URL がローカル repo 由来か (= viewer で開けるか) の判定に使う。
 * 存在しなければ false (呼び出し側で外部 URL を browser に出す等のフォールバックに使う)。
 */
export async function commitExists(
    repoCwd: string,
    ref: string,
): Promise<boolean> {
    if (!isSafeRef(ref)) return false;
    try {
        await execFileAsync(
            'git',
            [
                ...QUOTEPATH_OFF,
                'rev-parse',
                '--verify',
                '--quiet',
                `${ref}^{commit}`,
            ],
            { cwd: repoCwd },
        );
        return true;
    } catch {
        return false;
    }
}

export type CommitFileChange = {
    /** name-status の status (`A` / `M` / `D` / `R100` / `C75` 等) */
    status: string;
    /** 変更後 (rename 後) のリポジトリ相対パス */
    path: string;
    /** rename / copy 元のパス (R / C のときのみ) */
    oldPath?: string;
};

export type CommitDetail = {
    sha: string;
    shortSha: string;
    subject: string;
    author: string;
    /** `YYYY-MM-DD HH:MM` 形式 */
    date: string;
    /** コミットメッセージ全文 (subject + body、末尾改行除去) */
    body: string;
    /** 親コミット SHA (merge は複数, root は空) */
    parents: string[];
    files: CommitFileChange[];
};

// ASCII Unit Separator (0x1F)。subject/author に出てこない区切りとして使う。
// ソースに生制御文字を埋めないため fromCharCode で生成し、git 側は `%x1f` で出力。
const COMMIT_FIELD_SEP = String.fromCharCode(31);

/** `git ... --name-status -M` の出力を `CommitFileChange[]` に。 */
function parseNameStatus(stdout: string): CommitFileChange[] {
    const files: CommitFileChange[] = [];
    for (const line of stdout.split('\n')) {
        if (!line) continue;
        const parts = line.split('\t');
        const status = parts[0];
        if ((status[0] === 'R' || status[0] === 'C') && parts.length >= 3) {
            files.push({ status, oldPath: parts[1], path: parts[2] });
        } else if (parts.length >= 2) {
            files.push({ status, path: parts[1] });
        }
    }
    return files;
}

/**
 * 2 つの ref 間 (または ref ↔ 作業ツリー) で差分のあるファイル一覧。
 *   - `refA` と `refB` 両方指定 → `git diff <refA> <refB>`
 *   - `refB` 省略           → `git diff <refA>` (refA ↔ 作業ツリー)
 * 解決不能なら空配列。
 */
export async function getDiffFiles(
    repo: string,
    refA: string,
    refB?: string,
): Promise<CommitFileChange[]> {
    if (!isSafeRef(refA)) return [];
    if (refB !== undefined && !isSafeRef(refB)) return [];
    try {
        const { stdout } = await execFileAsync(
            'git',
            [
                ...QUOTEPATH_OFF,
                'diff',
                '--name-status',
                '-M',
                refA,
                ...(refB ? [refB] : []),
            ],
            { cwd: repo, maxBuffer: GIT_MAX_BUFFER },
        );
        return parseNameStatus(stdout);
    } catch {
        return [];
    }
}

/**
 * 指定 ref のコミット情報と、そのコミットで変更されたファイル一覧を取得する。
 * commit 参照リンク経由の「このコミットの変更ファイル一覧 / 前後コミット」閲覧で使う。
 * ref が解決できない (存在しない / repo 外) 場合は undefined。
 */
export async function getCommitDetail(
    repo: string,
    ref: string,
): Promise<CommitDetail | undefined> {
    if (!isSafeRef(ref)) return undefined;
    let header: string[];
    try {
        const { stdout } = await execFileAsync(
            'git',
            [
                ...QUOTEPATH_OFF,
                'show',
                '--no-patch',
                // %B (生メッセージ全文) は改行を含むので必ず最後に置く
                `--format=%H${COMMIT_FIELD_SEP}%h${COMMIT_FIELD_SEP}%s${COMMIT_FIELD_SEP}%an${COMMIT_FIELD_SEP}%ad${COMMIT_FIELD_SEP}%P${COMMIT_FIELD_SEP}%B`,
                '--date=format:%Y-%m-%d %H:%M',
                ref,
            ],
            { cwd: repo },
        );
        header = stdout.split(COMMIT_FIELD_SEP);
    } catch {
        return undefined;
    }
    if (header.length < 7) return undefined;
    const [sha, shortSha, subject, author, date, parentsRaw] = header;
    const body = header[6].replace(/\n+$/, '');

    let files: CommitFileChange[] = [];
    try {
        const { stdout } = await execFileAsync(
            'git',
            [
                ...QUOTEPATH_OFF,
                'diff-tree',
                '--no-commit-id',
                '--name-status',
                '-r',
                '-M',
                '--root',
                sha,
            ],
            { cwd: repo, maxBuffer: GIT_MAX_BUFFER },
        );
        files = parseNameStatus(stdout);
    } catch {
        // ファイル一覧が取れなくてもコミット情報自体は返す
    }

    return {
        sha,
        shortSha,
        subject,
        author,
        date,
        body,
        parents: parentsRaw ? parentsRaw.split(' ').filter(Boolean) : [],
        files,
    };
}

/**
 * `ref` の「子」コミット (= tip へ向かう ancestry path 上で `ref` の直後) を返す。
 * git の DAG に「子」は一意でないため tip への経路で最初に出会う子孫を採る
 * best-effort。tip は次の順で試す:
 *   1. 明示 `tip` 引数 (呼び出し側が branch を知っている場合)
 *   2. `HEAD`
 *   3. `ref` を含む branch / remote-tracking ref を自動探索
 * → これで HEAD に繋がらないブランチ上の commit でも「進む」が機能する。
 * どの tip でも子が無ければ undefined。
 */
export async function findChildCommit(
    repo: string,
    ref: string,
    tip?: string,
): Promise<string | undefined> {
    if (!isSafeRef(ref)) return undefined;
    // tip は内部 for-each-ref で取得した branch 名のことが多いが、明示渡しの
    // 可能性もあるので同様にガードする (refs/heads/foo 等は安全)
    if (tip !== undefined && !isSafeRef(tip)) return undefined;
    const childTowards = async (t: string): Promise<string | undefined> => {
        try {
            const { stdout } = await execFileAsync(
                'git',
                [
                    ...QUOTEPATH_OFF,
                    'rev-list',
                    '--reverse',
                    '--ancestry-path',
                    `${ref}..${t}`,
                ],
                { cwd: repo, maxBuffer: GIT_MAX_BUFFER },
            );
            return stdout.split('\n').find(Boolean) || undefined;
        } catch {
            return undefined;
        }
    };

    for (const t of [tip, 'HEAD']) {
        if (!t) continue;
        const c = await childTowards(t);
        if (c) return c;
    }
    // ref を含む ref (branch / remote) を tip 候補にして再探索
    try {
        const { stdout } = await execFileAsync(
            'git',
            [
                ...QUOTEPATH_OFF,
                'for-each-ref',
                '--format=%(refname)',
                '--contains',
                ref,
                'refs/heads',
                'refs/remotes',
            ],
            { cwd: repo, maxBuffer: GIT_MAX_BUFFER },
        );
        for (const r of stdout.split('\n').filter(Boolean)) {
            const c = await childTowards(r);
            if (c) return c;
        }
    } catch {
        // for-each-ref 不可なら諦める
    }
    return undefined;
}

/**
 * `origin` リモートの web ベース URL に正規化する。
 *   - `git@host:owner/repo.git`        → `https://host/owner/repo`
 *   - `ssh://git@host/owner/repo.git`  → `https://host/owner/repo`
 *   - `https://host/owner/repo(.git)`  → `https://host/owner/repo`
 * 解釈できなければ undefined。
 */
function remoteToWebBase(remote: string): string | undefined {
    const s = remote.trim();
    if (!s) return undefined;
    const scp = /^[^@/]+@([^:/]+):(.+)$/.exec(s);
    if (scp) {
        return `https://${scp[1]}/${scp[2].replace(/\.git$/, '')}`;
    }
    try {
        const u = new URL(s);
        const p = u.pathname.replace(/^\/+/, '').replace(/\.git$/, '');
        return `https://${u.host}/${p}`;
    } catch {
        return undefined;
    }
}

/**
 * `origin` リモート上の、その commit の web ページ URL を返す。
 * GitLab ホストは `/-/commit/<sha>`、それ以外 (GitHub 等) は `/commit/<sha>`。
 * リモート未設定 / 解釈不能なら undefined。
 */
export async function getRemoteCommitUrl(
    repo: string,
    sha: string,
): Promise<string | undefined> {
    let remote: string;
    try {
        const { stdout } = await execFileAsync(
            'git',
            [...QUOTEPATH_OFF, 'remote', 'get-url', 'origin'],
            { cwd: repo },
        );
        remote = stdout.trim();
    } catch {
        return undefined;
    }
    const base = remoteToWebBase(remote);
    if (!base) return undefined;
    return /gitlab/i.test(base)
        ? `${base}/-/commit/${sha}`
        : `${base}/commit/${sha}`;
}

/**
 * 任意の ref (commit SHA / branch / `HEAD^` 等) からファイル内容を取得する。
 * Git Graph などの commit-vs-commit 比較で使う。
 */
export async function readFileAtRef(
    repo: string,
    relativePath: string,
    ref: string,
): Promise<string | undefined> {
    if (!isSafeRef(ref)) return undefined;
    try {
        const { stdout } = await execFileAsync(
            'git',
            [...QUOTEPATH_OFF, 'show', `${ref}:${relativePath}`],
            {
                cwd: repo,
                maxBuffer: GIT_MAX_BUFFER,
            },
        );
        return stdout;
    } catch {
        // ref に存在しない or repo パス不正 等
        return undefined;
    }
}
