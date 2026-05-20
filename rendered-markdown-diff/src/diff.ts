import { diffLines } from 'diff';
import MarkdownIt from 'markdown-it';

const md = new MarkdownIt({
    html: true,
    linkify: true,
    breaks: false,
    typographer: false,
});

// ```` ```mermaid ```` フェンスを `<div class="mermaid">…</div>` に変換する。
// webview 側スクリプト (`webviewMermaid.ts`) がこれを拾って SVG レンダリングする。
// diff hint の class (`mdd-ins` / `mdd-mod-gutter` 等) が token に attach されている
// 場合に備えて `attrJoin('class', 'mermaid')` で merge してから renderAttrs で展開する。
const originalFenceRule = md.renderer.rules.fence;
md.renderer.rules.fence = (tokens, idx, options, env, self) => {
    const token = tokens[idx];
    const info = (token.info ?? '').trim().split(/\s+/)[0];
    if (info === 'mermaid') {
        token.attrJoin('class', 'mermaid');
        const attrs = self.renderAttrs(token);
        const content = md.utils.escapeHtml(token.content);
        return `<div${attrs}>${content}</div>`;
    }
    return originalFenceRule
        ? originalFenceRule(tokens, idx, options, env, self)
        : self.renderToken(tokens, idx, options);
};

/** render 系に渡す追加コンテキスト。`commitShas` は検証済み bare SHA 集合。 */
export type RenderEnv = { commitShas?: Set<string> };

// bare SHA (7〜40 hex) の autolink。GitHub と同様、呼び出し側 (viewerProvider) が
// `git rev-parse` で実在検証した SHA 集合のみを `env.commitShas` で渡してくる。
// core ルールで `text` トークンだけ走査するので code span / fence 内は対象外
// (= 地の文だけ link 化)。生成する <a> は git-commit-browser 拡張へ橋渡しする
// ためのマーカー (`data-commit-ref`) を持ち、href は無効化しておく。
const SHA_RE = /\b[0-9a-f]{7,40}\b/g;
md.core.ruler.push('mdd_commit_autolink', (state) => {
    const shas = (state.env as RenderEnv | undefined)?.commitShas;
    if (!shas || shas.size === 0) return;
    for (const block of state.tokens) {
        if (block.type !== 'inline' || !block.children) continue;
        const out: typeof block.children = [];
        for (const tok of block.children) {
            if (tok.type !== 'text') {
                out.push(tok);
                continue;
            }
            const text = tok.content;
            SHA_RE.lastIndex = 0;
            let last = 0;
            let replaced = false;
            let m: RegExpExecArray | null = SHA_RE.exec(text);
            while (m !== null) {
                const sha = m[0];
                if (shas.has(sha)) {
                    replaced = true;
                    if (m.index > last) {
                        const t = new state.Token('text', '', 0);
                        t.content = text.slice(last, m.index);
                        out.push(t);
                    }
                    const open = new state.Token('link_open', 'a', 1);
                    open.attrSet('class', 'mdd-commit-ref');
                    open.attrSet('data-commit-ref', sha);
                    open.attrSet('href', '#');
                    open.attrSet('title', 'このコミットを開く');
                    const inner = new state.Token('text', '', 0);
                    inner.content = sha.slice(0, 7);
                    const close = new state.Token('link_close', 'a', -1);
                    out.push(open, inner, close);
                    last = m.index + sha.length;
                }
                m = SHA_RE.exec(text);
            }
            if (!replaced) {
                out.push(tok);
                continue;
            }
            if (last < text.length) {
                const t = new state.Token('text', '', 0);
                t.content = text.slice(last);
                out.push(t);
            }
        }
        block.children = out;
    }
});

export type RenderResult = {
    headHtml: string;
    currentHtml: string;
    summary: { added: number; removed: number; unchanged: number };
};

/**
 * 2 ペイン (HEAD ↔ 作業ツリー / commit ↔ commit) で並べて見せるための HTML を構築する。
 *
 * - 行単位で diff を取り、追加行・削除行に CSS クラスを付ける
 * - markdown-it の token に直接 class を付与するので、ブロック構造を
 *   壊さずに block 要素単位 (paragraph / heading / list_item / ...) で
 *   ハイライトできる
 */
export function renderPairedDiff(
    headSource: string,
    currentSource: string,
    renderEnv?: RenderEnv,
): RenderResult {
    const changes = diffLines(headSource, currentSource);

    // head 側 / current 側それぞれで「強調対象の行番号集合」を作る
    const removedLines = new Set<number>();
    const addedLines = new Set<number>();

    let headCursor = 0;
    let currentCursor = 0;

    for (const change of changes) {
        const lineCount = change.count ?? countLines(change.value);
        if (change.added) {
            for (let i = 0; i < lineCount; i++)
                addedLines.add(currentCursor + i);
            currentCursor += lineCount;
        } else if (change.removed) {
            for (let i = 0; i < lineCount; i++)
                removedLines.add(headCursor + i);
            headCursor += lineCount;
        } else {
            headCursor += lineCount;
            currentCursor += lineCount;
        }
    }

    return {
        headHtml: renderWithHighlight(
            headSource,
            removedLines,
            'mdd-del',
            renderEnv,
        ),
        currentHtml: renderWithHighlight(
            currentSource,
            addedLines,
            'mdd-ins',
            renderEnv,
        ),
        summary: {
            added: addedLines.size,
            removed: removedLines.size,
            unchanged: countLines(headSource) - removedLines.size,
        },
    };
}

function countLines(value: string): number {
    if (value === '') return 0;
    // diff lib は末尾改行を含む形で value を返すので、改行で split したときの
    // 末尾空文字列は実体無しとして扱う
    const parts = value.split('\n');
    if (parts[parts.length - 1] === '') return parts.length - 1;
    return parts.length;
}

function renderWithHighlight(
    source: string,
    highlightLines: Set<number>,
    cssClass: string,
    renderEnv?: RenderEnv,
): string {
    const env: RenderEnv = { ...renderEnv };
    const tokens = md.parse(source, env);

    for (const token of tokens) {
        if (!token.map) continue;
        const [start, end] = token.map;
        let hit = false;
        for (let line = start; line < end; line++) {
            if (highlightLines.has(line)) {
                hit = true;
                break;
            }
        }
        if (hit) {
            token.attrJoin('class', cssClass);
        }
    }

    return md.renderer.render(tokens, md.options, env);
}

/**
 * 単独 preview (diff context でない) 用の plain markdown レンダリング。
 */
export function renderPlain(source: string, renderEnv?: RenderEnv): string {
    return md.render(source, { ...renderEnv });
}

export type SingleRenderResult = {
    html: string;
    summary: { added: number; modified: number; removed: number };
    hasChanges: boolean;
};

/**
 * 単独 viewer 用に「現行ファイル本体」だけをレンダリングしつつ、
 * 変更ヒントを **VSCode 標準のエディタ gutter 配色** に揃えて左マージンに描画する。
 *
 *   - 追加された行を含む top-level block → `.mdd-ins-gutter` (緑帯 / editorGutter.addedBackground)
 *   - 変更された行 (`removed` 直後の `added` ペア) → `.mdd-mod-gutter` (青帯 / editorGutter.modifiedBackground)
 *   - 単独削除があった位置 → `<div class="mdd-del-marker">` (赤三角 / editorGutter.deletedBackground)
 *
 * modified を別扱いにする理由: `diffLines` は行置換を「removed + added」ペアで返すので、
 * 何もしないと変更行に **緑帯と赤三角が両方** 付いて騒がしい表示になる。
 *
 * 2 ペイン diff の `renderPairedDiff` と異なりインライン背景塗りは行わず、
 * 「変更があるよ」を主張するだけの控えめ表示にする。
 */
export function renderWithGutter(
    headSource: string,
    currentSource: string,
    renderEnv?: RenderEnv,
): SingleRenderResult {
    const changes = diffLines(headSource, currentSource);

    const addedLines = new Set<number>();
    const modifiedLines = new Set<number>();
    // 純粋削除の発生位置 (current 側の line index = currentCursor の値そのもの)
    const deletionPositions: number[] = [];
    let removedCount = 0;
    let currentCursor = 0;

    for (let i = 0; i < changes.length; i++) {
        const change = changes[i];
        const lineCount = change.count ?? countLines(change.value);
        if (change.added) {
            // 直前 chunk が removed なら、ここは置換 (= modified) の追加側
            const prev = changes[i - 1];
            const target = prev?.removed ? modifiedLines : addedLines;
            for (let j = 0; j < lineCount; j++) target.add(currentCursor + j);
            currentCursor += lineCount;
        } else if (change.removed) {
            // 直後 chunk が added なら置換扱い (modified 側で表現される)。
            // それ以外は純粋削除なので三角マーカーを出す。
            const next = changes[i + 1];
            if (!next?.added) deletionPositions.push(currentCursor);
            removedCount += lineCount;
        } else {
            currentCursor += lineCount;
        }
    }

    const env: RenderEnv = { ...renderEnv };
    const tokens = md.parse(currentSource, env);

    // 変更行を含む top-level token に gutter クラスを付与
    // (modified は added より強い signal なので modified を優先)
    for (const token of tokens) {
        if (!token.map) continue;
        if (token.level !== 0) continue;
        const [start, end] = token.map;
        let hasMod = false;
        let hasAdd = false;
        for (let line = start; line < end; line++) {
            if (modifiedLines.has(line)) hasMod = true;
            else if (addedLines.has(line)) hasAdd = true;
        }
        if (hasMod) token.attrJoin('class', 'mdd-mod-gutter');
        else if (hasAdd) token.attrJoin('class', 'mdd-ins-gutter');
    }

    // tokens を top-level block group に分割 (削除マーカーを間に注入するため)
    type Group = { startLine: number; tokens: typeof tokens };
    const groups: Group[] = [];
    let i = 0;
    while (i < tokens.length) {
        const token = tokens[i];
        if (token.level !== 0) {
            i++;
            continue;
        }
        const start = i;
        const startLine = token.map?.[0] ?? 0;
        if (token.type.endsWith('_open')) {
            let depth = 1;
            i++;
            while (i < tokens.length && depth > 0) {
                if (tokens[i].type.endsWith('_open')) depth++;
                else if (tokens[i].type.endsWith('_close')) depth--;
                i++;
            }
        } else {
            i++;
        }
        groups.push({ startLine, tokens: tokens.slice(start, i) });
    }

    const sortedDeletions = [...deletionPositions].sort((a, b) => a - b);
    let delIdx = 0;

    let html = '';
    for (const group of groups) {
        while (
            delIdx < sortedDeletions.length &&
            sortedDeletions[delIdx] <= group.startLine
        ) {
            html += `<div class="mdd-del-marker" aria-label="この位置に削除あり" title="この位置で行が削除されています"></div>`;
            delIdx++;
        }
        html += md.renderer.render(group.tokens, md.options, env);
    }
    while (delIdx < sortedDeletions.length) {
        html += `<div class="mdd-del-marker" aria-label="末尾に削除あり" title="末尾で行が削除されています"></div>`;
        delIdx++;
    }

    return {
        html,
        summary: {
            added: addedLines.size,
            modified: modifiedLines.size,
            removed: removedCount,
        },
        hasChanges:
            addedLines.size > 0 ||
            modifiedLines.size > 0 ||
            sortedDeletions.length > 0,
    };
}
