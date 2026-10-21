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
        onShow: undefined,
        showOptions: undefined,
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
    assert.equal(state.shown, 0);
});

test('external regeneration and stale document content reject before editing', async () => {
    state.disk = 'new row\n' + state.disk;
    await assert.rejects(save(), /内容が一致しません/);
    state.disk = snapshot().source;
    state.source = 'different task\n';
    await assert.rejects(save(), /内容が一致しません/);
    assert.equal(state.applied, 0);
    assert.equal(state.saves, 0);
    assert.equal(state.shown, 2);
});

test('edit arriving during disk read rejects before apply', async () => {
    state.onRead = () => {
        state.version++;
    };
    await assert.rejects(save(), /内容が一致しません/);
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
    await assert.rejects(save(), /チェック対象の行/);
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
    assert.equal(state.shown, 0);
});

test('missing file notifications: latest board render and stale clean buffer reload before saving', async () => {
    const source = 'updated 10:01\n- [ ] task\n';
    state.disk = source;
    state.onShow = () => {
        state.source = state.disk;
        state.version++;
    };
    await saveCheckbox(uri, {
        id: 'fresh', source, offsets: new Map([['fresh-0', source.indexOf('[ ]') + 1]]),
    }, 'fresh-0', true);
    assert.equal(state.disk, 'updated 10:01\n- [x] task\n');
    assert.equal(state.applied, 1);
    assert.equal(state.shown, 1);
    assert.deepEqual(state.showOptions, { preview: true, preserveFocus: true, viewColumn: -2 });
});

test('board changes again while reload is pending: save uses the newest row position', async () => {
    state.disk = 'updated 10:01\n- [ ] task\n';
    state.onShow = () => {
        setTimeout(() => {
            state.source = state.disk = 'updated 10:02\n- [ ] other\n- [ ] task\n';
            state.version++;
        }, 150);
    };
    await save();
    assert.equal(state.disk, 'updated 10:02\n- [ ] other\n- [x] task\n');
    assert.equal(state.saves, 1);
});

test('user editing while reload is pending is never saved by the checkbox action', async () => {
    state.disk = 'new\n- [ ] task\n';
    state.onShow = () => {
        state.dirty = true;
        state.source += 'unsaved user edit';
        state.version++;
    };
    await assert.rejects(save(), /未保存/);
    assert.equal(state.applied, 0);
    assert.equal(state.saves, 0);
    assert.equal(state.disk, 'new\n- [ ] task\n');
});

test('failed reload leaves disk intact and releases the save lock', async () => {
    state.disk = 'new\n- [ ] task\n';
    state.onShow = () => { throw new Error('editor open failed'); };
    await assert.rejects(save(), /editor open failed/);
    assert.equal(state.applied, 0);
    assert.equal(state.saves, 0);
    assert.equal(state.disk, 'new\n- [ ] task\n');
    state.onShow = undefined;
    state.source = state.disk;
    await save();
    assert.equal(state.disk, 'new\n- [x] task\n');
});

const boardRow = (id: string, checked = false) => `| [${checked ? 'x' : ' '}] | ${id} | 3 | 同じ依頼 |\n`;
const boardSnapshot = (source: string, id: string) => {
    const at = source.indexOf(`| ${id} |`);
    const offset = source.lastIndexOf('[ ]', at) + 1;
    assert.ok(at >= 0 && offset > 0);
    return { id: 'board', source, offsets: new Map([['board-0', offset]]) };
};

test('board log reorders identical descriptions: the clicked ID is edited at its new position', async () => {
    const before = boardRow('U271') + boardRow('U272');
    state.source = state.disk = 'updated\n' + boardRow('U272') + boardRow('U271');
    await saveCheckbox(uri, boardSnapshot(before, 'U271'), 'board-0', true);
    assert.equal(state.disk, 'updated\n' + boardRow('U272') + boardRow('U271', true));
    assert.equal(state.applied, 1);
});

test('board ingestion removes the clicked row: do not recreate it or check the next row', async () => {
    const before = boardRow('U271') + boardRow('U272');
    state.source = state.disk = boardRow('U272');
    await assert.rejects(saveCheckbox(uri, boardSnapshot(before, 'U271'), 'board-0', true), /チェック対象の行/);
    assert.equal(state.applied, 0);
    assert.equal(state.saves, 0);
    assert.equal(state.disk, boardRow('U272'));
    assert.equal(state.shown, 0);
});

test('another save already checked and reordered the target: succeed without writing', async () => {
    const before = boardRow('U271') + boardRow('U272');
    state.source = state.disk = boardRow('U272') + boardRow('U271', true);
    await saveCheckbox(uri, boardSnapshot(before, 'U271'), 'board-0', true);
    assert.equal(state.applied, 0);
    assert.equal(state.saves, 0);
    assert.equal(state.disk, boardRow('U272') + boardRow('U271', true));
});

test('identical rows change in number: reject ambiguous relocation without editing', async () => {
    const before = boardRow('U271') + boardRow('U271');
    state.source = state.disk = boardRow('U271');
    await assert.rejects(saveCheckbox(uri, boardSnapshot(before, 'U271'), 'board-0', true), /チェック対象の行/);
    assert.equal(state.applied, 0);
    assert.equal(state.saves, 0);
});

test('already checked uppercase marker succeeds without adding an undo entry', async () => {
    state.source = state.disk = '- [X] task\n';
    await save();
    assert.equal(state.applied, 0);
    assert.equal(state.saves, 0);
    assert.equal(state.disk, '- [X] task\n');
});

test('already unchecked target after an external update also succeeds without writing', async () => {
    const initial = { ...snapshot(), source: '- [x] task\n' };
    await saveCheckbox(uri, initial, 'fresh-0', false);
    assert.equal(state.applied, 0);
    assert.equal(state.saves, 0);
});

test('changes to a different checkbox on the same line still reject relocation', async () => {
    const initial = { ...snapshot(), source: '- [ ] task [ ] other\n' };
    state.source = state.disk = '- [ ] task [x] other\n';
    await assert.rejects(saveCheckbox(uri, initial, 'fresh-0', true), /チェック対象の行/);
    assert.equal(state.applied, 0);
    assert.equal(state.saves, 0);
});

test('reordered rows equal except for checked state are ambiguous and never treated as completed', async () => {
    const initial = { ...snapshot(), source: '- [ ] task\n- [x] task\n' };
    state.source = state.disk = '- [x] task\n- [ ] task\n';
    await assert.rejects(saveCheckbox(uri, initial, 'fresh-0', true), /チェック対象の行/);
    assert.equal(state.applied, 0);
    assert.equal(state.saves, 0);
});
