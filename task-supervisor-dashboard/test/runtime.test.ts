import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { type Interaction, record } from '../src/actions.ts';
import { type ClientState, createGateway } from '../src/backend.ts';
import { type Action, Ledger, type PendingAnswer } from '../src/boardClient.ts';
import { OperationPending } from '../src/gateway.ts';
import { runtimeIO, runtimeRelative } from '../src/runtimeFiles.ts';
import {
    type Authority,
    type PendingRuntime,
    type Receipt,
    type RuntimeCommand,
    RuntimeGateway,
    type RuntimeJournal,
    type RuntimePorts,
    type RuntimeResult,
    type RuntimeSnapshot,
} from '../src/runtimeGateway.ts';

const authority = (): Authority => ({
    schemaVersion: 1,
    mode: 'authoritative',
    epoch: 'epoch-1',
    migrationId: 'migration-1',
    fingerprint: 'fingerprint-1',
});
const action = (extra: Partial<Action> = {}): Action => ({
    id: 'U341',
    taskId: 'T341',
    text: '操作の対象',
    kind: 'execution',
    command: 'echo 確認',
    needsOk: true,
    done: false,
    ...extra,
});
function fixture(row = action()) {
    let saved: PendingRuntime | undefined;
    const writes: (PendingRuntime | undefined)[] = [];
    const journal: RuntimeJournal = {
        get: () => saved,
        set: async (value) => {
            saved = value === undefined ? undefined : structuredClone(value);
            writes.push(saved);
        },
    };
    const snapshot: RuntimeSnapshot = {
        schemaVersion: 1,
        mode: 'authoritative',
        generation: 'process-1',
        registry: { version: 1, actions: [row] },
        tasks: [{ id: 'T341', version: 17 }],
    };
    const sent: RuntimeCommand[] = [];
    const queried: Receipt[] = [];
    let result: RuntimeResult | undefined;
    const ports: RuntimePorts = {
        authority: async () => authority(),
        snapshot: async () => snapshot,
        capabilities: async () => ({
            schemaVersion: 1,
            authoritativeWrites: true,
            operations: ['action.complete', 'action.executed', 'action.answer'],
        }),
        submit: async (command) => {
            sent.push(structuredClone(command));
            result = {
                schemaVersion: 1,
                commandId: command.commandId,
                status: 'applied',
                code: 'ok',
                version: 18,
                message: '適用済み',
            };
            return {
                commandId: command.commandId,
                status: 'queued',
                resultPath: '/fixture/result.json',
            };
        },
        result: async (receipt) => {
            queried.push(receipt);
            return result;
        },
        answerContext: async (selected, documentVersion) => ({
            schemaVersion: 1,
            taskVersion: 17,
            actionId: selected.id,
            requestVersion: 'a'.repeat(64),
            document: documentVersion
                ? { ref: selected.doc!, version: documentVersion }
                : null,
            request: { text: selected.text, doc: selected.doc ?? null },
        }),
        journal,
    };
    return {
        ports,
        snapshot,
        sent,
        queried,
        journal,
        writes,
        gateway: new RuntimeGateway('/fixture', 'epoch-1', ports),
        setResult: (value: RuntimeResult | undefined) => {
            result = value;
        },
    };
}
async function selected(f: ReturnType<typeof fixture>): Promise<Action> {
    return (await f.gateway.read()).actions[0];
}
function pendingAnswer(): PendingAnswer {
    return {
        id: 'U341',
        commandId: 'same-answer-id',
        answer: '  回答\n原文  ',
        respondent: '利用者',
        requestVersion: 'a'.repeat(64),
        documentVersion: '改訂2',
        confirmedResult: true,
        runtime: { epoch: 'epoch-1', taskId: 'T341', version: 17 },
    };
}

for (const [op, type] of [
    ['complete', 'action.complete'],
    ['ran', 'action.executed'],
] as const) {
    test(`${type}は所属T番号・U番号・選択時のタスク版を封筒へ渡す`, async () => {
        const f = fixture();
        await f.gateway.complete(await selected(f), op);
        const command = f.sent[0];
        assert.equal(command.schemaVersion, 1);
        assert.equal(command.targetId, 'T341');
        assert.equal(command.expectedVersion, 17);
        assert.equal(command.type, type);
        assert.equal(command.source, 'vscode.task-supervisor');
        assert.match(command.commandId, /^[a-f0-9-]{36}$/);
        assert.deepEqual(
            command.payload,
            op === 'complete'
                ? { actionId: 'U341', confirmedResult: true }
                : { actionId: 'U341' },
        );
        assert.equal(f.journal.get(), undefined);
        assert.equal(f.writes[0]?.command.commandId, command.commandId);
    });
}
test('回答は取得したcontextのタスク版と原文・回答者・資料版・同じ操作IDを渡す', async () => {
    const f = fixture(
        action({
            kind: 'decision',
            command: undefined,
            doc: 'https://example.com/doc',
        }),
    );
    const context = await f.gateway.answerContext(await selected(f), '改訂2');
    assert.deepEqual(context.runtime, pendingAnswer().runtime);
    assert.deepEqual(context.document, {
        ref: 'https://example.com/doc',
        version: '改訂2',
    });
    await f.gateway.answer({ ...pendingAnswer(), runtime: context.runtime });
    assert.deepEqual(f.sent[0], {
        schemaVersion: 1,
        commandId: 'same-answer-id',
        targetId: 'T341',
        expectedVersion: 17,
        source: 'vscode.task-supervisor',
        type: 'action.answer',
        payload: {
            actionId: 'U341',
            answer: '  回答\n原文  ',
            respondent: '利用者',
            requestVersion: 'a'.repeat(64),
            documentVersion: '改訂2',
            confirmedResult: true,
        },
    });
});
test('所属タスクのない依頼や読取り後に版が変わった依頼は送らない', async () => {
    const standalone = fixture(action({ taskId: undefined }));
    await assert.rejects(
        standalone.gateway.complete(await selected(standalone), 'complete'),
        /対象タスクの版/,
    );
    assert.equal(standalone.sent.length, 0);
    const f = fixture();
    const old = await selected(f);
    f.snapshot.tasks[0].version = 18;
    await assert.rejects(
        f.gateway.complete(old, 'complete'),
        /版が変わりました/,
    );
    assert.equal(f.sent.length, 0);
});
test('queuedは成功にせずjournalを残し同じIDの結果を照会する', async () => {
    const f = fixture();
    f.ports.result = async (receipt) => {
        f.queried.push(receipt);
        return undefined;
    };
    await assert.rejects(
        f.gateway.complete(await selected(f), 'complete'),
        OperationPending,
    );
    const saved = structuredClone(f.journal.get()!);
    assert.equal(saved.receipt?.status, 'queued');
    await assert.rejects(f.gateway.resume(), OperationPending);
    assert.equal(f.sent.length, 1);
    assert.deepEqual(f.queried, [saved.receipt, saved.receipt]);
    assert.deepEqual(f.journal.get(), saved);
});
test('適用済み結果でだけ成功を返し担当の受領・処理完了と区別する', async () => {
    const f = fixture();
    const realResult = f.ports.result;
    f.ports.result = async () => undefined;
    await assert.rejects(
        f.gateway.complete(await selected(f), 'complete'),
        OperationPending,
    );
    f.ports.result = realResult;
    const resumed = await f.gateway.resume();
    assert.equal(resumed?.commandId, f.sent[0].commandId);
    assert.equal(resumed?.operation, 'complete');
    assert.match(resumed!.message, /適用済み/);
    assert.match(resumed!.message, /受領・処理完了とは別/);
    assert.equal(f.journal.get(), undefined);
});
test('拒否結果は理由を表示し成功にせず未確定journalを解消する', async () => {
    const f = fixture();
    f.ports.result = async (receipt) => ({
        schemaVersion: 1,
        commandId: receipt.commandId,
        status: 'rejected',
        code: 'version-conflict',
        message: '版が異なります',
    });
    await assert.rejects(
        f.gateway.complete(await selected(f), 'complete'),
        /version-conflict.*版が異なります/,
    );
    assert.equal(f.journal.get(), undefined);
});
test('送信結果不明の再起動後は同じ封筒を再送し新しいIDを作らない', async () => {
    const f = fixture();
    const submit = f.ports.submit;
    f.ports.submit = async (command) => {
        f.sent.push(structuredClone(command));
        throw new Error('送信結果不明');
    };
    await assert.rejects(
        f.gateway.complete(await selected(f), 'complete'),
        /送信結果不明/,
    );
    const saved = structuredClone(f.journal.get()!);
    assert.equal(saved.receipt, undefined);
    f.ports.submit = submit;
    const restarted = new RuntimeGateway('/fixture', 'epoch-1', {
        ...f.ports,
        journal: { get: () => saved, set: f.journal.set },
    });
    await restarted.resume();
    assert.equal(f.sent.length, 2);
    assert.deepEqual(f.sent[1], f.sent[0]);
    assert.equal(f.journal.get(), undefined);
});
test('受付済みjournalは再起動後も再送せず元の結果パスを照会する', async () => {
    const f = fixture();
    const result = f.ports.result;
    f.ports.result = async () => undefined;
    await assert.rejects(f.gateway.answer(pendingAnswer()), OperationPending);
    const saved = structuredClone(f.journal.get()!);
    f.ports.result = result;
    const restarted = new RuntimeGateway('/fixture', 'epoch-1', {
        ...f.ports,
        journal: { get: () => saved, set: f.journal.set },
    });
    assert.equal((await restarted.resume())?.operation, 'answer');
    assert.equal(f.sent.length, 1);
    assert.deepEqual(f.queried[0], saved.receipt);
});
for (const next of [
    undefined,
    { ...authority(), mode: 'preparing' as const },
    { ...authority(), epoch: 'epoch-2' },
]) {
    test(`正本が${next?.mode ?? '消失'}・世代${next?.epoch ?? '不明'}に変われば未確定操作を再送しない`, async () => {
        const f = fixture();
        f.ports.submit = async () => {
            throw new Error('送信結果不明');
        };
        await assert.rejects(f.gateway.answer(pendingAnswer()), /送信結果不明/);
        const saved = structuredClone(f.journal.get());
        f.ports.authority = async () => next;
        await assert.rejects(f.gateway.resume(), /切替状態が変わりました/);
        assert.deepEqual(f.journal.get(), saved);
        await assert.rejects(f.gateway.read(), /切替状態が変わりました/);
    });
}
for (const op of ['complete', 'ran', 'answer'] as const) {
    test(`${op}が機能一覧で未対応なら旧CLIで代用せず送信もしない`, async () => {
        const f = fixture(
            action({ kind: op === 'answer' ? 'decision' : 'execution' }),
        );
        f.ports.capabilities = async () => ({
            schemaVersion: 1,
            authoritativeWrites: true,
            operations: [],
        });
        await assert.rejects(
            op === 'answer'
                ? f.gateway.answer(pendingAnswer())
                : f.gateway.complete(await selected(f), op),
            /未対応.*旧CLI/,
        );
        assert.equal(f.sent.length, 0);
        assert.equal(f.journal.get(), undefined);
    });
}
test('操作ID違いの結果は採用せずjournalを保持する', async () => {
    const f = fixture();
    f.ports.result = async () => ({
        schemaVersion: 1,
        commandId: 'another-id',
        status: 'applied',
        code: 'ok',
        message: '別操作',
    });
    await assert.rejects(f.gateway.answer(pendingAnswer()), /結果形式が不正/);
    assert.equal(f.journal.get()?.command.commandId, 'same-answer-id');
});
test('画面はqueuedを保存成功として通知せず次回操作で同じ結果を確認する', async () => {
    const f = fixture();
    const infos: string[] = [];
    const errors: string[] = [];
    const ui: Interaction = {
        pick: async (rows) => rows[0],
        choice: async () => 'recommended',
        recover: async () => 'retry',
        input: async () => '利用者',
        answerInput: async () => '回答',
        confirm: async () => true,
        info: (value) => {
            infos.push(value);
        },
        error: (value) => {
            errors.push(value);
        },
    };
    const drafts = { get: () => undefined, set: async () => {} };
    f.ports.result = async () => undefined;
    await record('complete', f.gateway, ui, drafts);
    assert.equal(errors.length, 0);
    assert.match(infos[0], /結果待ち/);
    assert.doesNotMatch(infos[0], /記録しました|適用済み/);
    assert.equal(f.sent.length, 1);
});

async function files() {
    const root = await mkdtemp(join(tmpdir(), 'supervisor-runtime-'));
    const directory = join(root, runtimeRelative);
    await mkdir(join(directory, 'results'), { recursive: true });
    return {
        root,
        directory,
        async [Symbol.asyncDispose]() {
            await rm(root, { recursive: true, force: true });
        },
    };
}
function state(): ClientState {
    const values = new Map<string, unknown>();
    return {
        get: <T>(key: string) => values.get(key) as T | undefined,
        set: async (key, value) => {
            values.set(key, structuredClone(value));
        },
    };
}
test('結果パスの外部参照・相対パス・結果ファイルsymlinkを拒否する', async () => {
    await using f = await files();
    const io = runtimeIO(f.root, async () => {
        throw new Error('CLIは呼ばない');
    });
    const receipt = (resultPath: string): Receipt => ({
        commandId: 'id',
        status: 'queued',
        resultPath,
    });
    for (const path of [
        join(f.root, 'outside.json'),
        'results/result.json',
        join(f.directory, 'results/nested/result.json'),
    ]) {
        await assert.rejects(io.result(receipt(path)), /結果パス/);
    }
    const outside = join(f.root, 'outside.json');
    await writeFile(outside, '{}');
    const linked = join(f.directory, 'results/linked.json');
    await symlink(outside, linked);
    await assert.rejects(io.result(receipt(linked)), { code: 'ELOOP' });
    assert.equal(
        await io.result(receipt(join(f.directory, 'results/missing.json'))),
        undefined,
    );
});
test('結果ディレクトリのsymlinkを拒否する', async () => {
    await using f = await files();
    const actual = join(f.root, 'actual');
    await mkdir(actual);
    await rm(join(f.directory, 'results'), { recursive: true });
    await symlink(actual, join(f.directory, 'results'));
    const io = runtimeIO(f.root, async () => '');
    await assert.rejects(
        io.result({
            commandId: 'id',
            status: 'queued',
            resultPath: join(f.directory, 'results/id.json'),
        }),
        /ディレクトリが不正/,
    );
});
test('結果パスの中間symlinkと親参照で対象外の結果を読まない', async () => {
    await using f = await files();
    const outside = join(f.root, 'outside');
    await mkdir(join(outside, 'child'), { recursive: true });
    const results = join(f.directory, 'results');
    await symlink(join(outside, 'child'), join(results, 'link'));
    await writeFile(
        join(outside, 'result.json'),
        JSON.stringify({ message: '対象外' }),
    );
    await writeFile(
        join(results, 'result.json'),
        JSON.stringify({ message: '対象内' }),
    );
    const result = await runtimeIO(f.root, async () => '').result({
        commandId: 'id',
        status: 'queued',
        resultPath: `${results}/link/../result.json`,
    });
    assert.equal(result?.message, '対象内');
});
test('正本記録のない初回だけ旧台帳を選び切替開始後は旧操作を拒否する', async () => {
    await using f = await files();
    const gateway = await createGateway(
        f.root,
        process.execPath,
        'missing-board.ts',
        'missing-runtime.ts',
        state(),
    );
    assert.ok(gateway instanceof Ledger);
    await writeFile(
        join(f.directory, 'authority.json'),
        JSON.stringify({ ...authority(), mode: 'preparing' }),
    );
    await assert.rejects(gateway.answer(pendingAnswer()), /常駐部へ送った回答/);
    await assert.rejects(gateway.read(), /切替が始まりました/);
});
for (const mode of ['authoritative', 'preparing'] as const) {
    test(`${mode}を観測した後に正本記録が消えても旧CLIへ戻らない`, async () => {
        await using f = await files();
        const saved = state();
        await writeFile(
            join(f.directory, 'authority.json'),
            JSON.stringify({ ...authority(), mode }),
        );
        if (mode === 'preparing') {
            await assert.rejects(
                createGateway(
                    f.root,
                    process.execPath,
                    'missing-board.ts',
                    'missing-runtime.ts',
                    saved,
                ),
                /切替中/,
            );
        } else {
            assert.ok(
                (await createGateway(
                    f.root,
                    process.execPath,
                    'missing-board.ts',
                    'missing-runtime.ts',
                    saved,
                )) instanceof RuntimeGateway,
            );
        }
        await rm(join(f.directory, 'authority.json'));
        await assert.rejects(
            createGateway(
                f.root,
                process.execPath,
                'missing-board.ts',
                'missing-runtime.ts',
                saved,
            ),
            /旧CLIへ自動で戻しません/,
        );
    });
}

test('旧台帳で切替開始を観測した後は記録消失後も旧CLIへ戻らない', async () => {
    await using f = await files();
    const saved = state();
    const gateway = await createGateway(
        f.root,
        process.execPath,
        'missing-board.ts',
        'missing-runtime.ts',
        saved,
    );
    await writeFile(
        join(f.directory, 'authority.json'),
        JSON.stringify({ ...authority(), mode: 'preparing' }),
    );
    await assert.rejects(gateway.read(), /切替が始まりました/);
    await rm(join(f.directory, 'authority.json'));
    await assert.rejects(
        createGateway(
            f.root,
            process.execPath,
            'missing-board.ts',
            'missing-runtime.ts',
            saved,
        ),
        /旧CLIへ自動で戻しません/,
    );
    await assert.rejects(gateway.read(), /切替が始まりました/);
});
test('正本記録の破損を観測した後は削除されても旧CLIへ戻らない', async () => {
    await using f = await files();
    const saved = state();
    await writeFile(join(f.directory, 'authority.json'), '{途中で切れたJSON');
    await assert.rejects(
        createGateway(
            f.root,
            process.execPath,
            'missing-board.ts',
            'missing-runtime.ts',
            saved,
        ),
    );
    await rm(join(f.directory, 'authority.json'));
    await assert.rejects(
        createGateway(
            f.root,
            process.execPath,
            'missing-board.ts',
            'missing-runtime.ts',
            saved,
        ),
        /旧CLIへ自動で戻しません/,
    );
});

for (const taskVersion of [
    16,
    18,
    -1,
    1.5,
    Number.MAX_SAFE_INTEGER + 1,
    undefined,
    '17',
]) {
    test(`回答contextのタスク版${String(taskVersion)}は選択時の版へ付け替えず拒否する`, async () => {
        const f = fixture(action({ kind: 'decision', command: undefined }));
        const context = f.ports.answerContext;
        f.ports.answerContext = async (row, documentVersion) =>
            ({
                ...(await context(row, documentVersion)),
                taskVersion,
            }) as Awaited<ReturnType<RuntimePorts['answerContext']>>;
        await assert.rejects(f.gateway.answerContext(await selected(f)), /版/);
        assert.equal(f.sent.length, 0);
        assert.equal(f.journal.get(), undefined);
    });
}
test('回答context読取りアダプターはU番号とURL資料版を固定CLI引数で渡す', async () => {
    await using f = await files();
    const calls: string[][] = [];
    const expected = {
        schemaVersion: 1,
        actionId: 'U341',
        taskVersion: 17,
        requestVersion: 'a'.repeat(64),
        document: null,
        request: { text: '操作の対象', doc: null },
    };
    const io = runtimeIO(f.root, async (args) => {
        calls.push(args);
        return JSON.stringify(expected);
    });
    assert.deepEqual(
        await io.answerContext(action(), '改訂2 $(確認)'),
        expected,
    );
    assert.deepEqual(await io.answerContext(action()), expected);
    assert.deepEqual(calls, [
        ['answer-context', 'U341', '--document-version', '改訂2 $(確認)'],
        ['answer-context', 'U341'],
    ]);
});
