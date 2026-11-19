import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    parseUserActionsView,
    type UserActionRow,
    UserActionsUnavailable,
    viewInfo,
    viewOperations,
} from '../src/userActionsView.ts';

const executed = {
    id: 'U9',
    version: 'row v/3',
    action: {
        id: 'U9',
        taskId: 'T1',
        text: '一般の実行依頼',
        createdAt: 1,
        ranAt: 2,
        done: false,
        futureActionField: { preserve: [1, 2] },
    },
    task: {
        id: 'T1',
        title: '対象タスク',
        status: '実装中',
        futureTaskField: 7,
    },
    kind: 'execution',
    lifecycle: 'executed',
    availability: {
        actionable: true,
        held: false,
        holdReason: null,
        pendingPrerequisites: [],
    },
    operations: {
        execute: false,
        answer: false,
        complete: true,
        confirmResult: false,
    },
} satisfies UserActionRow;
const awaitingResult = {
    ...executed,
    id: 'U2',
    action: {
        id: 'U2',
        text: '結果確認を要する実行依頼',
        createdAt: 1,
        ranAt: 2,
        needsOk: true,
        done: false,
    },
    task: null,
    lifecycle: 'awaiting-result',
    operations: {
        execute: false,
        answer: false,
        complete: false,
        confirmResult: true,
    },
} satisfies UserActionRow;
const decision = {
    ...executed,
    id: 'U6',
    action: {
        id: 'U6',
        taskId: 'T1',
        text: '判断依頼',
        command: '判断材料に含まれるコマンド',
        createdAt: 1,
        done: false,
    },
    kind: 'decision',
    lifecycle: 'decision',
    operations: {
        execute: false,
        answer: true,
        complete: true,
        confirmResult: false,
    },
} satisfies UserActionRow;
const held = {
    ...executed,
    id: 'U3',
    action: {
        id: 'U3',
        taskId: 'T1',
        text: '保留中の実行依頼',
        command: '確認する',
        createdAt: 1,
        done: false,
    },
    lifecycle: 'unexecuted',
    availability: {
        actionable: false,
        held: true,
        holdReason: '前提の完了待ち',
        pendingPrerequisites: ['U1'],
    },
    operations: {
        execute: false,
        answer: false,
        complete: false,
        confirmResult: false,
    },
} satisfies UserActionRow;
const ready = {
    schemaVersion: 1,
    viewVersion: 'view@2026-11-19',
    status: 'ready',
    source: {
        mode: 'authoritative',
        epoch: 'e-1',
        fetchedAt: 1000,
        error: null,
    },
    rows: [executed, awaitingResult, decision, held],
};
const unavailable = {
    ...ready,
    status: 'unavailable',
    source: {
        mode: 'legacy',
        epoch: null,
        fetchedAt: null,
        error: { code: 'BOARD_UNAVAILABLE', message: '台帳を取得できません' },
    },
    rows: null,
};

test('供給元の順序・版・追加属性を保持する', () => {
    const wire = {
        ...ready,
        futureViewField: true,
        source: { ...ready.source, futureSourceField: 1 },
        rows: [{ ...executed, futureRowField: '値' }, ...ready.rows.slice(1)],
    };
    const view = parseUserActionsView(wire);
    assert.deepEqual(view, wire);
    assert.equal(view.status, 'ready');
    assert.deepEqual(
        view.rows.map((row) => row.id),
        ['U9', 'U2', 'U6', 'U3'],
    );
    assert.equal(view.rows[0].version, 'row v/3');
    assert.deepEqual(viewInfo(view), {
        status: 'ready',
        viewVersion: 'view@2026-11-19',
        source: ready.source,
    });
});

test('一般の実行済み・結果確認待ち・判断・保留の操作候補は供給元の操作フラグに従う', () => {
    const view = parseUserActionsView(ready);
    assert.equal(view.status, 'ready');
    assert.deepEqual(view.rows.map(viewOperations), [
        ['complete'],
        ['complete'],
        ['complete', 'answer'],
        [],
    ]);
    const row = {
        ...held,
        action: { ...held.action, done: true, ranAt: 3, holdReason: '保留' },
        availability: { ...held.availability, actionable: true },
        operations: { ...held.operations, execute: true },
    };
    const inconsistentRawAction = parseUserActionsView({
        ...ready,
        rows: [row],
    });
    assert.equal(inconsistentRawAction.status, 'ready');
    assert.deepEqual(viewOperations(inconsistentRawAction.rows[0]), ['ran']);
});

test('正常な空一覧と取得失敗を区別し、失敗の詳細を保持する', () => {
    assert.deepEqual(parseUserActionsView({ ...ready, rows: [] }).rows, []);
    const failed = parseUserActionsView(unavailable);
    assert.equal(failed.status, 'unavailable');
    assert.equal(failed.rows, null);
    assert.deepEqual(viewInfo(failed), {
        status: 'unavailable',
        viewVersion: ready.viewVersion,
        source: unavailable.source,
    });
    const error = new UserActionsUnavailable(failed);
    assert.equal(error.view, failed);
    assert.match(error.message, /BOARD_UNAVAILABLE.+台帳を取得できません/);
});

test('対応範囲外のスキーマ・版・状態・読取り元の型を拒否する', () => {
    const invalid = [
        [{ ...ready, schemaVersion: 2 }, /schemaVersion/],
        [{ ...ready, viewVersion: '' }, /viewVersion/],
        [{ ...ready, viewVersion: 1 }, /viewVersion/],
        [{ ...ready, status: 'loading' }, /status/],
        [
            { ...ready, source: { ...ready.source, mode: 'preparing' } },
            /source/,
        ],
        [{ ...ready, source: { ...ready.source, epoch: 1 } }, /source/],
        [
            { ...ready, source: { ...ready.source, fetchedAt: '1000' } },
            /source/,
        ],
        [
            { ...ready, source: { ...ready.source, fetchedAt: Infinity } },
            /source/,
        ],
    ] as const;
    for (const [value, expected] of invalid)
        assert.throws(() => parseUserActionsView(value), expected);
    assert.equal(
        parseUserActionsView({
            ...ready,
            source: { ...ready.source, mode: 'shadow' },
        }).source.mode,
        'shadow',
    );
});

test('取得状態と配列・エラーの組み合わせを検証する', () => {
    for (const value of [
        { ...ready, rows: null },
        { ...ready, source: unavailable.source },
        { ...unavailable, rows: [] },
        { ...unavailable, source: ready.source },
        {
            ...unavailable,
            source: { ...unavailable.source, error: { code: '失敗' } },
        },
    ])
        assert.throws(
            () => parseUserActionsView(value),
            /rows \/ source\.error/,
        );
});

test('行の版・種別・IDの対応・関連タスクと操作フラグを検証する', () => {
    assert.throws(
        () => parseUserActionsView({ ...ready, rows: [executed, executed] }),
        /rows\[1\]\.id の重複/,
    );
    for (const row of [
        { ...executed, id: 'U1' },
        { ...executed, version: 1 },
        { ...executed, version: '' },
        { ...executed, lifecycle: 'started' },
        { ...executed, kind: 'unknown' },
        { ...executed, task: { id: 'T1', title: '対象タスク' } },
        { ...executed, task: undefined },
        {
            ...executed,
            availability: { ...executed.availability, actionable: false },
        },
        { ...held, availability: { ...held.availability, actionable: true } },
        {
            ...held,
            availability: { ...held.availability, pendingPrerequisites: [1] },
        },
        { ...held, operations: { ...held.operations, confirmResult: 0 } },
        {
            ...held,
            operations: { ...held.operations, futureOperation: true },
            availability: { ...held.availability, actionable: true },
        },
    ])
        assert.throws(
            () => parseUserActionsView({ ...ready, rows: [row] }),
            /rows\[0\]/,
        );
});
