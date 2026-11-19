import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
    Ledger,
    candidates,
    type Action,
    type PendingAnswer,
    type Registry,
} from '../src/boardClient.ts';
import { record, type Interaction } from '../src/actions.ts';
import { captureAnswer } from '../src/answerEditor.ts';

const action = (extra: Partial<Action> = {}): Action => ({
    id: 'U1',
    taskId: 'T1',
    text: '依頼の全文',
    summary: '依頼',
    kind: 'execution',
    command: 'echo 確認',
    needsOk: true,
    done: false,
    ...extra,
});
async function setup(a: Action) {
    const root = await mkdtemp(join(tmpdir(), 'supervisor-actions-'));
    const dir = join(root, '.agents/ローカルタスク/監督');
    await mkdir(dir, { recursive: true });
    const registry: Registry = { version: 1, actions: [a] };
    const save = async () => {
        await writeFile(join(dir, 'registry.json'), JSON.stringify(registry));
    };
    await save();
    const calls: string[][] = [];
    const infos: string[] = [];
    const errors: string[] = [];
    const draft = new Map<string, PendingAnswer>();
    let inputs = ['利用者'];
    let commandId = '';
    const run = async (args: string[]): Promise<string> => {
        calls.push(args);
        if (args[0] === 'answer-context')
            return JSON.stringify({
                schemaVersion: 1,
                actionId: a.id,
                requestVersion: 'a'.repeat(64),
                document: null,
                request: { text: a.text, doc: null },
            });
        if (args[0] === 'done') a.done = true;
        if (args[0] === 'ran') a.ranAt = 1;
        if (args[0] === 'answer') {
            const value = (k: string) => args[args.indexOf(k) + 1];
            commandId = value('--command-id');
            a.done = true;
            a.answers = [
                {
                    commandId,
                    answer: value('--answer'),
                    respondent: value('--respondent'),
                    requestVersion: value('--request-version'),
                },
            ];
        }
        await save();
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
        a,
        registry,
        save,
        run,
        calls,
        infos,
        errors,
        ui,
        drafts,
        draft,
        inputs,
        ledger: new Ledger(root, run),
        async [Symbol.asyncDispose]() {
            await rm(root, { recursive: true, force: true });
        },
    };
}
test('保留・前提・取り下げ・完了を除外し実行と判断を選び分ける', () => {
    const r: Registry = {
        version: 1,
        actions: [
            action(),
            action({ id: 'U2', kind: 'decision' }),
            action({ id: 'U3', holdReason: '待つ' }),
            action({ id: 'U4', after: ['U1'] }),
            action({ id: 'U5', withdrawal: {} }),
            action({ id: 'U6', done: true }),
        ],
    };
    assert.deepEqual(
        candidates(r, 'complete').map((a) => a.id),
        ['U1']
    );
    assert.deepEqual(
        candidates(r, 'answer').map((a) => a.id),
        ['U2']
    );
});
test('完了は明示確認後に--okを渡し台帳のdoneを読戻す', async () => {
    await using f = await setup(action());
    await record('complete', f.ledger, f.ui, f.drafts);
    assert.deepEqual(f.calls, [['done', 'U1', '--ok']]);
    assert.equal(f.errors.length, 0);
    assert.match(f.infos[0], /完了/);
});
test('取消ではCLIを呼ばない', async () => {
    await using f = await setup(action());
    f.ui.confirm = async () => false;
    await record('complete', f.ledger, f.ui, f.drafts);
    assert.deepEqual(f.calls, []);
    assert.equal(f.a.done, false);
});
test('キック済みを完了と混同しない', async () => {
    await using f = await setup(action());
    await record('ran', f.ledger, f.ui, f.drafts);
    assert.deepEqual(f.calls, [['ran', 'U1']]);
    assert.equal(f.a.done, false);
    assert.equal(f.a.ranAt, 1);
});
test('自由回答は原文・回答者・開始時の版・操作IDをanswerへ渡す', async () => {
    await using f = await setup(
        action({ kind: 'decision', command: undefined })
    );
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
    await using f = await setup(
        action({ kind: 'decision', command: undefined })
    );
    f.ui.choice = async () => 'recommended';
    await record('answer', f.ledger, f.ui, f.drafts);
    assert.equal(f.a.answers![0].answer, '推奨で進める');
});
test('古いCLIのhelp出力を回答API成功として扱わない', async () => {
    await using f = await setup(
        action({ kind: 'decision', command: undefined })
    );
    await record(
        'answer',
        new Ledger(f.root, async () => 'board.ts help'),
        f.ui,
        f.drafts
    );
    assert.match(f.errors[0], /回答APIが未対応/);
    assert.equal(f.a.done, false);
});
test('CLI非0と終了0だが未保存のとき成功を表示しない', async () => {
    await using f = await setup(action());
    await record(
        'complete',
        new Ledger(f.root, async () => {
            throw new Error('CLI失敗');
        }),
        f.ui,
        f.drafts
    );
    assert.match(f.errors[0], /CLI失敗/);
    await record(
        'complete',
        new Ledger(f.root, async () => ''),
        f.ui,
        f.drafts
    );
    assert.match(f.errors[1], /記録を確認できません/);
    assert.deepEqual(f.infos, []);
});
test('確認中に依頼が変われば完了を拒否する', async () => {
    await using f = await setup(action());
    f.ui.confirm = async () => {
        f.registry.actions = [{ ...f.a, text: '変更後' }];
        await f.save();
        return true;
    };
    await record('complete', f.ledger, f.ui, f.drafts);
    assert.match(f.errors[0], /更新/);
    assert.deepEqual(f.calls, []);
});
test('回答失敗後の再送では原文と操作IDを保持する', async () => {
    await using f = await setup(
        action({ kind: 'decision', command: undefined })
    );
    let failed = true;
    const ledger = new Ledger(f.root, async (args) => {
        if (args[0] === 'answer' && failed) {
            failed = false;
            f.calls.push(args);
            throw Error('通信結果不明');
        }
        return f.run(args);
    });
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
        '前の下書き'
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
        undefined
    );
});
test('結果確認不要の実行依頼もキック候補に含める', async () => {
    await using f = await setup(action({ needsOk: false }));
    assert.equal(candidates(f.registry, 'ran').length, 1);
    await record('ran', f.ledger, f.ui, f.drafts);
    assert.deepEqual(f.calls, [['ran', 'U1']]);
    assert.equal(f.a.done, false);
});
test('URL資料版は入力開始時に取得し両CLIへ同じ値を渡す', async () => {
    await using f = await setup(
        action({
            kind: 'decision',
            doc: 'https://example.com/decision',
            command: undefined,
        })
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
        action({
            kind: 'decision',
            doc: 'https://example.com/decision',
            command: undefined,
        })
    );
    f.ui.input = async () => undefined;
    await record('answer', f.ledger, f.ui, f.drafts);
    assert.deepEqual(f.calls, []);
    f.ui.input = async () => '';
    await record('answer', f.ledger, f.ui, f.drafts);
    assert.match(f.errors[0], /確認した版/);
    assert.deepEqual(f.calls, []);
});
