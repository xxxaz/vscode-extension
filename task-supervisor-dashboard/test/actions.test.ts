import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { type Interaction, record } from '../src/actions.ts';
import { captureAnswer } from '../src/answerEditor.ts';
import {
    type Action,
    candidates,
    Ledger,
    type PendingAnswer,
    type Registry,
} from '../src/boardClient.ts';
import type { UserActionRow } from '../src/userActionsView.ts';
import {
    actionable,
    awaitingResult,
    noOperations,
    type RowState,
    readyView,
    viewRow,
    waitingForDecision,
    waitingForExecution,
} from './viewFixture.ts';

const action = (extra: Partial<Action> = {}): Action => ({
    id: 'U1',
    taskId: 'T1',
    text: '依頼の全文',
    summary: '依頼',
    kind: 'execution',
    command: 'echo 確認',
    needsOk: true,
    done: false,
    createdAt: 1,
    ...extra,
});
const executionRequestGeneral = {
    ...waitingForExecution,
    operations: { ...noOperations, execute: true, complete: true },
} satisfies RowState;
const executedGeneral = {
    kind: 'execution',
    lifecycle: 'executed',
    availability: actionable,
    operations: { ...noOperations, complete: true },
} satisfies RowState;
const unavailableOperations = { ...actionable, actionable: false };

const resultRow = () => viewRow(action({ ranAt: 1 }), awaitingResult);
const decisionRow = (extra: Partial<Action> = {}) =>
    viewRow(
        action({
            kind: 'decision',
            command: undefined,
            needsOk: false,
            ...extra,
        }),
        waitingForDecision,
    );

async function setup(
    initialRow: UserActionRow,
    afterRan: RowState = awaitingResult,
) {
    const root = await mkdtemp(join(tmpdir(), 'supervisor-actions-'));
    let current = initialRow;
    const readView = async () => readyView([structuredClone(current)]);
    const calls: string[][] = [];
    const infos: string[] = [];
    const errors: string[] = [];
    const draft = new Map<string, PendingAnswer>();
    const inputs = ['利用者'];
    const run = async (args: string[]): Promise<string> => {
        calls.push(args);
        const a = current.action;
        if (args[0] === 'answer-context')
            return JSON.stringify({
                schemaVersion: 1,
                actionId: a.id,
                requestVersion: 'a'.repeat(64),
                document: null,
                request: { text: a.text, doc: null },
            });
        if (args[0] === 'done') {
            current = viewRow(
                { ...a, done: true },
                {
                    kind: current.kind,
                    lifecycle: 'completed',
                    availability: unavailableOperations,
                    operations: noOperations,
                },
            );
        }
        if (args[0] === 'ran') current = viewRow({ ...a, ranAt: 1 }, afterRan);
        if (args[0] === 'answer') {
            const value = (k: string) => args[args.indexOf(k) + 1];
            current = viewRow(
                {
                    ...a,
                    done: true,
                    answers: [
                        {
                            commandId: value('--command-id'),
                            answer: value('--answer'),
                            respondent: value('--respondent'),
                            requestVersion: value('--request-version'),
                        },
                    ],
                },
                {
                    kind: 'decision',
                    lifecycle: 'completed',
                    availability: unavailableOperations,
                    operations: noOperations,
                },
            );
        }
        return '';
    };
    const ui: Interaction = {
        pick: async (rows) => rows[0],
        choice: async () => 'custom',
        recover: async () => 'retry',
        input: async () => inputs.shift(),
        answerInput: async (initial) => initial ?? '原文\nそのまま',
        confirm: async () => true,
        info: (m) => {
            infos.push(m);
        },
        error: (m) => {
            errors.push(m);
        },
    };
    const drafts = {
        get: (key: string) => draft.get(key),
        set: async (key: string, value: PendingAnswer | undefined) => {
            if (value) draft.set(key, value);
            else draft.delete(key);
        },
    };
    return {
        root,
        get a() {
            return current.action;
        },
        readView,
        updateRow: (row: UserActionRow) => {
            current = row;
        },
        run,
        calls,
        infos,
        errors,
        ui,
        drafts,
        draft,
        inputs,
        ledger: new Ledger(root, run, undefined, readView),
        async [Symbol.asyncDispose]() {
            await rm(root, { recursive: true, force: true });
        },
    };
}
test('保留・前提・取り下げ・完了の除外と判断の両候補は共通の操作候補に従う', () => {
    const held = {
        kind: 'execution',
        lifecycle: 'unexecuted',
        availability: {
            ...unavailableOperations,
            held: true,
            holdReason: '待つ',
        },
        operations: noOperations,
    } satisfies RowState;
    const rows = [
        viewRow(action({ needsOk: false }), executionRequestGeneral),
        decisionRow({ id: 'U2' }),
        viewRow(action({ id: 'U3', holdReason: '待つ' }), held),
        viewRow(action({ id: 'U4', after: ['U1'] }), {
            ...held,
            availability: {
                ...held.availability,
                pendingPrerequisites: ['U1'],
            },
        }),
        viewRow(action({ id: 'U5', withdrawal: {} }), {
            ...held,
            lifecycle: 'withdrawn',
        }),
        viewRow(action({ id: 'U6', done: true }), {
            ...held,
            lifecycle: 'completed',
        }),
    ];
    const r: Registry = {
        version: 1,
        actions: [...rows.map((row) => row.action), action({ id: 'U99' })],
        userActions: readyView(rows),
    };
    assert.deepEqual(
        candidates(r, 'complete').map((a) => a.id),
        ['U1', 'U2'],
    );
    assert.deepEqual(
        candidates(r, 'ran').map((a) => a.id),
        ['U1'],
    );
    assert.deepEqual(
        candidates(r, 'answer').map((a) => a.id),
        ['U2'],
    );
});
test('完了は明示確認後に--okを渡し台帳のdoneを読戻す', async () => {
    await using f = await setup(resultRow());
    await record('complete', f.ledger, f.ui, f.drafts);
    assert.deepEqual(f.calls, [['done', 'U1', '--ok']]);
    assert.equal(f.errors.length, 0);
    assert.match(f.infos[0], /完了/);
});
test('取消ではCLIを呼ばない', async () => {
    await using f = await setup(resultRow());
    f.ui.confirm = async () => false;
    await record('complete', f.ledger, f.ui, f.drafts);
    assert.deepEqual(f.calls, []);
    assert.equal(f.a.done, false);
});
test('キック済みを完了と混同しない', async () => {
    await using f = await setup(viewRow(action(), waitingForExecution));
    await record('ran', f.ledger, f.ui, f.drafts);
    assert.deepEqual(f.calls, [['ran', 'U1']]);
    assert.equal(f.a.done, false);
    assert.equal(f.a.ranAt, 1);
    assert.equal(candidates(await f.ledger.read(), 'ran').length, 0);
    assert.equal(candidates(await f.ledger.read(), 'complete').length, 1);
});
test('自由回答は原文・回答者・開始時の版・操作IDをanswerへ渡す', async () => {
    await using f = await setup(decisionRow());
    await record('answer', f.ledger, f.ui, f.drafts);
    const args = f.calls[1];
    assert.equal(args[0], 'answer');
    assert.equal(args[args.indexOf('--answer') + 1], '原文\nそのまま');
    assert.equal(args[args.indexOf('--respondent') + 1], '利用者');
    assert.equal(args[args.indexOf('--request-version') + 1], 'a'.repeat(64));
    assert.equal(f.draft.size, 0);
    assert.equal(f.errors.length, 0);
});
test('推奨回答は固定の推奨文を保存する', async () => {
    await using f = await setup(decisionRow());
    f.ui.choice = async () => 'recommended';
    await record('answer', f.ledger, f.ui, f.drafts);
    assert.equal(f.a.answers![0].answer, '推奨で進める');
});
test('判断依頼の完了候補は推奨回答と回答者を記録する', async () => {
    await using f = await setup(decisionRow());
    await record('complete', f.ledger, f.ui, f.drafts);
    assert.deepEqual(
        f.calls.map(([command]) => command),
        ['answer-context', 'answer'],
    );
    assert.equal(f.a.answers?.[0].answer, '推奨で進める');
    assert.equal(f.a.answers?.[0].respondent, '利用者');
    assert.equal(f.a.done, true);
    assert.deepEqual(f.errors, []);
});
test('古いCLIのhelp出力を回答API成功として扱わない', async () => {
    await using f = await setup(decisionRow());
    await record(
        'answer',
        new Ledger(f.root, async () => 'board.ts help', undefined, f.readView),
        f.ui,
        f.drafts,
    );
    assert.match(f.errors[0], /回答APIが未対応/);
    assert.equal(f.a.done, false);
});
test('操作一覧は共通read CLIの応答から読み取る', async () => {
    const calls: string[][] = [];
    const rows = [decisionRow()];
    const ledger = new Ledger('/fixture', async (args) => {
        calls.push(args);
        return JSON.stringify(readyView(rows));
    });
    const registry = await ledger.read();
    assert.deepEqual(calls, [['user-actions', '--json']]);
    const [candidate] = candidates(registry, 'answer');
    assert.equal(candidate.id, rows[0].id);
    assert.equal(candidate.text, rows[0].action.text);
    assert.deepEqual(candidates(registry, 'complete'), [candidate]);
});
test('共通read非対応のCLIには変更操作を送らず、取得失敗を表示する', async () => {
    await using f = await setup(resultRow());
    const calls: string[][] = [];
    const ledger = new Ledger(f.root, async (args) => {
        calls.push(args);
        return 'board.ts help';
    });
    f.ui.pick = async () => assert.fail('取得失敗時に操作候補を表示した');
    await record('complete', ledger, f.ui, f.drafts);
    assert.deepEqual(calls, [['user-actions', '--json']]);
    assert.match(f.errors[0], /共通操作一覧のread応答が不正/);
    assert.deepEqual(f.infos, []);
    assert.equal(f.a.done, false);
});
test('CLI非0と終了0だが未保存のとき成功を表示しない', async () => {
    await using f = await setup(resultRow());
    await record(
        'complete',
        new Ledger(
            f.root,
            async () => {
                throw new Error('CLI失敗');
            },
            undefined,
            f.readView,
        ),
        f.ui,
        f.drafts,
    );
    assert.match(f.errors[0], /CLI失敗/);
    await record(
        'complete',
        new Ledger(f.root, async () => '', undefined, f.readView),
        f.ui,
        f.drafts,
    );
    assert.match(f.errors[1], /記録を確認できません/);
    assert.deepEqual(f.infos, []);
});
test('確認中に依頼が変われば完了を拒否する', async () => {
    await using f = await setup(resultRow());
    f.ui.confirm = async () => {
        f.updateRow({
            ...viewRow({ ...f.a, text: '変更後' }, awaitingResult),
            version: '更新後の版',
        });
        return true;
    };
    await record('complete', f.ledger, f.ui, f.drafts);
    assert.match(f.errors[0], /更新/);
    assert.deepEqual(f.calls, []);
});
test('確認中に共通一覧の操作候補から外れた依頼は完了を拒否する', async () => {
    const row = resultRow();
    await using f = await setup(row);
    f.ui.confirm = async () => {
        f.updateRow({
            ...row,
            version: '前提の更新後の表示版',
            availability: {
                actionable: false,
                held: true,
                holdReason: '前提の完了待ち',
                pendingPrerequisites: ['U2'],
            },
            operations: noOperations,
        });
        return true;
    };
    await record('complete', f.ledger, f.ui, f.drafts);
    assert.match(f.errors[0], /更新/);
    assert.deepEqual(f.calls, []);
});
test('回答失敗後の再送では原文と操作IDを保持する', async () => {
    await using f = await setup(decisionRow());
    let failed = true;
    const ledger = new Ledger(
        f.root,
        async (args) => {
            if (args[0] === 'answer' && failed) {
                failed = false;
                f.calls.push(args);
                throw Error('通信結果不明');
            }
            return f.run(args);
        },
        undefined,
        f.readView,
    );
    await record('answer', ledger, f.ui, f.drafts);
    assert.equal(f.draft.size, 1);
    const first = f.calls.find((a) => a[0] === 'answer')!;
    await record('answer', ledger, f.ui, f.drafts);
    const retry = f.calls.filter((a) => a[0] === 'answer')[1];
    assert.deepEqual(retry, first);
    assert.equal(f.draft.size, 0);
});

test('自由原文は無題エディターのgetTextから改行と空白を変えずに受け取る', async () => {
    const raw = '  一行目\n二行目\r\n三行目  ';
    const order: string[] = [];
    const result = await captureAnswer(
        {
            open: async (content) => {
                assert.equal(content, '前の下書き');
                order.push('open');
                return { getText: () => raw };
            },
            show: async () => {
                order.push('show');
            },
            confirm: async () => {
                order.push('confirm');
                return true;
            },
        },
        '前の下書き',
    );
    assert.equal(result, raw);
    assert.deepEqual(order, ['open', 'show', 'confirm']);
    assert.equal(
        await captureAnswer({
            open: async () => ({
                getText: () => {
                    throw Error('取消で読み取らない');
                },
            }),
            show: async () => {},
            confirm: async () => false,
        }),
        undefined,
    );
});
test('結果確認不要の実行依頼はキック後に --ok 無しで完了できる', async () => {
    await using f = await setup(
        viewRow(action({ needsOk: false }), executionRequestGeneral),
        executedGeneral,
    );
    assert.equal(candidates(await f.ledger.read(), 'ran').length, 1);
    await record('ran', f.ledger, f.ui, f.drafts);
    assert.deepEqual(f.calls, [['ran', 'U1']]);
    assert.equal(f.a.done, false);
    assert.equal(candidates(await f.ledger.read(), 'ran').length, 0);
    await record('complete', f.ledger, f.ui, f.drafts);
    assert.deepEqual(f.calls, [
        ['ran', 'U1'],
        ['done', 'U1'],
    ]);
    assert.equal(f.a.done, true);
});
test('URL資料版は入力開始時に取得し両CLIへ同じ値を渡す', async () => {
    await using f = await setup(
        decisionRow({
            doc: 'https://example.com/decision',
        }),
    );
    f.inputs.splice(0, f.inputs.length, '改訂2', '利用者');
    await record('answer', f.ledger, f.ui, f.drafts);
    assert.deepEqual(f.calls[0], [
        'answer-context',
        'U1',
        '--document-version',
        '改訂2',
    ]);
    const args = f.calls[1];
    assert.equal(args[args.indexOf('--document-version') + 1], '改訂2');
    assert.equal(f.errors.length, 0);
});
test('URL資料版の取消と空欄では回答を送信しない', async () => {
    await using f = await setup(
        decisionRow({
            doc: 'https://example.com/decision',
        }),
    );
    f.ui.input = async () => undefined;
    await record('answer', f.ledger, f.ui, f.drafts);
    assert.deepEqual(f.calls, []);
    f.ui.input = async () => '';
    await record('answer', f.ledger, f.ui, f.drafts);
    assert.match(f.errors[0], /確認した版/);
    assert.deepEqual(f.calls, []);
});
