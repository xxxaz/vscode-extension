import MarkdownIt from 'markdown-it';

export type CheckboxSnapshot = {
    id: string;
    source: string;
    offsets: Map<string, number>;
};
export type CheckboxEnv = { checkboxes?: CheckboxSnapshot };

/** Markdown の構文として解釈されたマーカーだけを、元ファイルの位置と対応付ける。 */
export function checkboxPlugin(md: MarkdownIt): void {
    md.inline.ruler.after('image', 'mdd_checkbox', (state, silent) => {
        const pos = state.pos;
        const marker = state.src.slice(pos, pos + 3);
        if (
            !/^\[[ xX]\]$/.test(marker) ||
            state.tokens.reduce(
                (depth, token) =>
                    depth +
                    (token.type === 'link_open'
                        ? 1
                        : token.type === 'link_close'
                          ? -1
                          : 0),
                0
            ) > 0
        )
            return false;
        if (pos > 0 && !/\s/.test(state.src[pos - 1])) return false;
        if (pos + 3 < state.posMax && !/\s/.test(state.src[pos + 3]))
            return false;
        if (!silent) {
            const token = state.push('mdd_checkbox', 'input', 0);
            token.content = marker;
            token.meta = { inlineOffset: pos };
        }
        state.pos += 3;
        return true;
    });

    md.core.ruler.after('inline', 'mdd_checkbox_locations', (state) => {
        const snapshot = (state.env as CheckboxEnv).checkboxes;
        // normalize で CRLF が LF になるため、保存対象の offsets は元の文字列で求める。
        const source = snapshot?.source ?? state.src;
        const lines = source.split(/\r\n|\r|\n/);
        const starts: number[] = [];
        let offset = 0;
        for (const match of source.matchAll(/[^\r\n]*(?:\r\n|\r|\n|$)/g)) {
            starts.push(offset);
            offset += match[0].length;
        }
        let row: number | undefined;
        let cursor = 0;
        for (const block of state.tokens) {
            if (block.type === 'tr_open') {
                row = block.map?.[0];
                cursor = 0;
            } else if (block.type === 'tr_close') {
                row = undefined;
            }
            if (block.type !== 'inline' || !block.children) continue;
            let positions: number[] | undefined;
            if (row !== undefined) {
                const raw = lines[row] ?? '';
                const normalized = normalizeTableLine(raw);
                const start = normalized.text.indexOf(block.content, cursor);
                if (start >= 0) {
                    positions = normalized.positions
                        .slice(start, start + block.content.length)
                        .map((column) => starts[row!] + column);
                    cursor = start + block.content.length;
                }
            } else if (block.map) {
                positions = [];
                for (const [line, content] of block.content
                    .split('\n')
                    .entries()) {
                    const n = block.map[0] + line;
                    const raw = lines[n] ?? '';
                    const start = raw.indexOf(content);
                    // 一意に対応できない構文では、編集可能な control を作らない。
                    if (start < 0 || raw.indexOf(content, start + 1) >= 0) {
                        positions = undefined;
                        break;
                    }
                    for (let i = 0; i < content.length; i++)
                        positions.push(starts[n] + start + i);
                    positions.push(-1);
                }
            }
            const hasHtml = block.children.some(
                (token, i) =>
                    token.type === 'html_inline' &&
                    !isInertHtml(block.children!, i)
            );
            for (const token of block.children) {
                if (token.type !== 'mdd_checkbox') continue;
                const local: number = token.meta.inlineOffset;
                const at = positions?.[local];
                if (
                    hasHtml ||
                    at === undefined ||
                    at < 0 ||
                    source.slice(at, at + 3) !== token.content
                ) {
                    token.type = 'text';
                    continue;
                }
                if (snapshot) {
                    const key = `${snapshot.id}-${snapshot.offsets.size}`;
                    snapshot.offsets.set(key, at + 1);
                    token.attrSet('data-mdd-checkbox', key);
                }
            }
        }
    });
    md.renderer.rules.mdd_checkbox = (tokens, idx, _opts, _env, renderer) => {
        const token = tokens[idx];
        const editable = token.attrGet('data-mdd-checkbox') !== null;
        return `<input type="checkbox" class="mdd-checkbox" aria-label="完了"${token.content[1] !== ' ' ? ' checked' : ''}${editable ? '' : ' disabled'}${renderer.renderAttrs(token)}>`;
    };
}

/** 文字を囲まない HTML (コメント・改行・中身が空の id/name だけのアンカー) は、チェックの位置対応に影響しない。 */
function isInertHtml(
    tokens: { type: string; content: string }[],
    index: number
): boolean {
    const html = tokens[index].content;
    if (/^<!--[\s\S]*-->$/.test(html) || /^<br\s*\/?>$/i.test(html))
        return true;
    if (/^<a\s+(?:id|name)="[^"<>]*"\s*>$/i.test(html))
        return (
            tokens[index + 1]?.type === 'html_inline' &&
            /^<\/a\s*>$/i.test(tokens[index + 1].content)
        );
    return (
        /^<\/a\s*>$/i.test(html) &&
        index > 0 &&
        /^<a\s+(?:id|name)="[^"<>]*"\s*>$/i.test(tokens[index - 1].content)
    );
}

function normalizeTableLine(line: string): {
    text: string;
    positions: number[];
} {
    let text = '';
    const positions: number[] = [];
    for (let i = 0; i < line.length; i++) {
        if (line[i] === '\\' && line[i + 1] === '|') continue;
        text += line[i];
        positions.push(i);
    }
    return { text, positions };
}

export function checkboxEdit(
    snapshot: CheckboxSnapshot,
    key: unknown,
    checked: unknown
): { offset: number; text: string } | undefined {
    if (typeof key !== 'string' || typeof checked !== 'boolean')
        return undefined;
    const offset = snapshot.offsets.get(key);
    if (offset === undefined) return undefined;
    const marker = snapshot.source.slice(offset - 1, offset + 2);
    if (!/^\[[ xX]\]$/.test(marker) || (marker[1] !== ' ') === checked)
        return undefined;
    return { offset, text: checked ? 'x' : ' ' };
}

/**
 * 描画後にファイルが書き換わっていても (ボードの定期更新など)、押されたチェックと同じ行を現在の内容から探し直す。
 * 対象マーカーの状態だけを除いて行を照合する。元と現在で各一件の場合だけ対応付ける。
 * 複数行の出現順は外部更新で変わりうるため使わない。要求された状態かどうかは保存側で判定する。
 */
export function relocateCheckbox(
    snapshot: CheckboxSnapshot,
    current: string,
    key: string,
    checked: boolean
): { offset: number; text: string } | undefined {
    const offset = snapshot.offsets.get(key);
    if (offset === undefined) return undefined;
    const line = lineAt(snapshot.source, offset);
    const column = offset - line.start;
    const sameBefore = linesEqual(snapshot.source, line.text, column);
    const sameNow = linesEqual(current, line.text, column);
    if (sameBefore.length !== 1 || sameNow.length !== 1) return undefined;
    const start = sameNow[0];
    if (start === undefined) return undefined;
    const marker = current.slice(start + column - 1, start + column + 2);
    if (!/^\[[ xX]\]$/.test(marker))
        return undefined;
    return { offset: start + column, text: checked ? 'x' : ' ' };
}

function lineAt(
    source: string,
    offset: number
): { start: number; text: string } {
    const start = Math.max(
        source.lastIndexOf('\n', offset - 1),
        source.lastIndexOf('\r', offset - 1)
    ) + 1;
    const end = source.slice(offset).search(/[\r\n]|$/);
    return { start, text: source.slice(start, offset + end) };
}

function linesEqual(source: string, text: string, checkboxColumn: number): number[] {
    const starts: number[] = [];
    let start = 0;
    for (const match of source.matchAll(/[^\r\n]*(?:\r\n|\r|\n|$)/g)) {
        const candidate = match[0].replace(/[\r\n]+$/, '');
        const marker = candidate.slice(checkboxColumn - 1, checkboxColumn + 2);
        if (
            /^\[[ xX]\]$/.test(marker) &&
            candidate.slice(0, checkboxColumn) === text.slice(0, checkboxColumn) &&
            candidate.slice(checkboxColumn + 1) === text.slice(checkboxColumn + 1)
        ) starts.push(start);
        start += match[0].length;
    }
    return starts;
}
