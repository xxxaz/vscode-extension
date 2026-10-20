import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import type * as vscode from 'vscode';
import { saveCheckbox } from '../src/checkboxEditing.js';
import { state, uri as mockUri } from './vscodeMock.js';

const uri = mockUri as unknown as vscode.Uri;
const snapshot = () => ({
    id: 'fresh',
    source: '- [ ] task\n',
    offsets: new Map([['fresh-0', 3]]),
});
const save = () => saveCheckbox(uri, snapshot(), 'fresh-0', true);
beforeEach(() =>
    Object.assign(state, {
        source: '- [ ] task\n',
        disk: '- [ ] task\n',
        dirty: false,
        version: 1,
        applied: 0,
        saves: 0,
        shown: 0,
        applyResult: true,
        saveResult: true,
        onRead: undefined,
        onApply: undefined,
        saveError: false,
    })
);

test('uses a one-character WorkspaceEdit and saves checked state', async () => {
    await save();
    assert.equal(state.disk, '- [x] task\n');
    assert.equal(state.applied, 1);
    assert.equal(state.saves, 1);
    assert.equal(state.shown, 0);
});

test('immutable URI and missing editable snapshot never open an edit', async () => {
    await assert.rejects(
        saveCheckbox(
            { ...mockUri, scheme: 'git' } as unknown as vscode.Uri,
            snapshot(),
            'fresh-0',
            true
        ),
        /読み取り専用/
    );
    await assert.rejects(
        saveCheckbox(uri, undefined, 'fresh-0', true),
        /読み取り専用/
    );
    assert.equal(state.applied, 0);
});

test('dirty document is never edited or saved', async () => {
    state.dirty = true;
    await assert.rejects(save(), /未保存/);
    assert.equal(state.applied, 0);
    assert.equal(state.saves, 0);
});

test('external regeneration and stale document content reject before editing', async () => {
    state.disk = 'new row\n' + state.disk;
    await assert.rejects(save(), /変更されています/);
    state.disk = snapshot().source;
    state.source = 'different task\n';
    await assert.rejects(save(), /変更されています/);
    assert.equal(state.applied, 0);
});

test('edit arriving during disk read rejects before apply', async () => {
    state.onRead = () => {
        state.version++;
    };
    await assert.rejects(save(), /変更されています/);
    assert.equal(state.applied, 0);
});

test('external edit arriving after apply is not overwritten by save', async () => {
    state.onApply = () => {
        state.disk = 'external changes';
    };
    await assert.rejects(save(), /編集中/);
    assert.equal(state.saves, 0);
    assert.equal(state.disk, 'external changes');
    assert.equal(state.shown, 1);
});

test('concurrent buffer edit after apply is not saved', async () => {
    state.onApply = () => {
        state.source += 'user edit';
        state.version++;
    };
    await assert.rejects(save(), /編集中/);
    assert.equal(state.saves, 0);
    assert.equal(state.shown, 1);
});

test('failed apply leaves disk unchanged', async () => {
    state.applyResult = false;
    await assert.rejects(save(), /適用できません/);
    assert.equal(state.saves, 0);
    assert.equal(state.shown, 0);
});

test('false and throwing save expose unsaved change in text editor', async () => {
    state.saveResult = false;
    await assert.rejects(save(), /保存できません/);
    assert.equal(state.shown, 1);
    assert.equal(state.disk, snapshot().source);
    state.source = snapshot().source;
    state.dirty = false;
    state.saveError = true;
    await assert.rejects(save(), /disk write failed/);
    assert.equal(state.shown, 2);
});

test('parallel clicks on same file are rejected, lock clears after completion', async () => {
    const pending = save();
    await assert.rejects(save(), /保存中/);
    await pending;
    state.source = snapshot().source;
    state.disk = snapshot().source;
    await save();
    assert.equal(state.saves, 2);
});

test('UTF-8 BOM follows the same decoder as viewer content', async () => {
    state.disk = '\ufeff' + state.disk;
    await save();
    assert.equal(state.saves, 1);
});

test('file regenerated after render (rows added, same line) still saves the clicked box', async () => {
    state.source = state.disk = 'updated 10:01\n- [ ] other\n- [ ] task\n';
    await save();
    assert.equal(state.disk, 'updated 10:01\n- [ ] other\n- [x] task\n');
    assert.equal(state.applied, 1);
});

test('regenerated file without the clicked line rejects before editing', async () => {
    state.source = state.disk = '- [ ] renamed\n';
    await assert.rejects(save(), /変更されています/);
    assert.equal(state.applied, 0);
});

test('editor buffer catching up with disk shortly after is waited for', async () => {
    const next = 'head\n- [ ] task\n';
    state.disk = next;
    setTimeout(() => {
        state.source = next;
        state.version++;
    }, 150);
    await save();
    assert.equal(state.disk, 'head\n- [x] task\n');
});
