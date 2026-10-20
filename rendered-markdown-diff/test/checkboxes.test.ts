import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkboxEdit, type CheckboxSnapshot } from '../src/checkboxes.js';
import {
    renderPlain,
    renderWithGutter,
    renderPairedDiff,
} from '../src/diff.js';

function render(source: string) {
    const snapshot: CheckboxSnapshot = {
        id: 'render-1',
        source,
        offsets: new Map(),
    };
    const html = renderPlain(source, { checkboxes: snapshot });
    return { snapshot, html };
}

test('board table maps repeated markers and escaped pipes to exact source positions', () => {
    const source =
        '| ID | Done | Work |\n|---|---|---|\n| U128 | [ ] | same |\n| U129 | [ ] [X] | pipe \\| [x] |\n';
    const { snapshot, html } = render(source);
    assert.equal(snapshot.offsets.size, 4);
    assert.equal((html.match(/type="checkbox"/g) ?? []).length, 4);
    const entries = [...snapshot.offsets.entries()];
    assert.deepEqual(
        entries.map(([, at]) => source.slice(at - 1, at + 2)),
        ['[ ]', '[ ]', '[X]', '[x]']
    );
    assert.equal(entries[1][1], source.indexOf('[ ] [X]') + 1);
    const edit = checkboxEdit(snapshot, entries[1][0], true)!;
    const updated =
        source.slice(0, edit.offset) +
        edit.text +
        source.slice(edit.offset + 1);
    assert.equal(updated, source.replace('[ ] [X]', '[x] [X]'));
});

test('nested tasks, blockquotes, Unicode, CRLF and multiple markers retain exact offsets', () => {
    const source =
        '> - [ ] 日本語😀\r\n>   - [X] nested\r\n\r\n- [ ] one [x] two\r\n';
    const { snapshot } = render(source);
    assert.deepEqual(
        [...snapshot.offsets.values()],
        [...source.matchAll(/\[[ xX]\]/g)].map((m) => m.index + 1)
    );
});

test('code, escaped markers, links, reference links, images and raw HTML are not controls', () => {
    const source =
        '`[ ]` \\[ ] [x](url) ![ ](image) [x]\n\n[x]: /ref\n\n```md\n- [ ] code\n```\n\n    [ ] indented\n\n<code>[ ]</code>\n\n<div>\n[ ]\n</div>\n';
    const { snapshot, html } = render(source);
    assert.equal(snapshot.offsets.size, 0);
    assert.equal(html.includes('data-mdd-checkbox'), false);
});

test('read-only plain and original diff cannot create editable controls', () => {
    const source = '- [ ] task';
    assert.match(renderPlain(source), /disabled/);
    const snapshot: CheckboxSnapshot = {
        id: 'current',
        source,
        offsets: new Map(),
    };
    const paired = renderPairedDiff('- [x] task', source, {
        checkboxes: snapshot,
    });
    assert.match(paired.headHtml, /checked disabled/);
    assert.doesNotMatch(paired.headHtml, /data-mdd-checkbox/);
    assert.match(paired.currentHtml, /data-mdd-checkbox="current-0"/);
    assert.equal(snapshot.offsets.size, 1);
    const gutter = renderWithGutter('', source, {
        checkboxes: { id: 'gutter', source, offsets: new Map() },
    });
    assert.match(gutter.html, /data-mdd-checkbox="gutter-0"/);
});

test('forged identifiers, malformed state and duplicate state are rejected', () => {
    const { snapshot } = render('- [ ] task');
    assert.equal(checkboxEdit(snapshot, 'old-render-0', true), undefined);
    assert.equal(checkboxEdit(snapshot, 'render-1-0', 'true'), undefined);
    assert.equal(checkboxEdit(snapshot, 'render-1-0', false), undefined);
    assert.deepEqual(checkboxEdit(snapshot, 'render-1-0', true), {
        offset: 3,
        text: 'x',
    });
});
