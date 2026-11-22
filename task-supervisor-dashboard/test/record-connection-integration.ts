// cspell:words noprofile norc
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type {
    RecordCaller,
    RecordCommand,
    RecordRead,
    RecordReadResult,
} from '../src/contracts/records.ts';
import { ExecutionRunner } from '../src/executionRunner.ts';
import { nodeExecutionProcess } from '../src/nodeExecutionProcess.ts';
import {
    KnownRecordRejection,
    type RecordChannel,
    RecordConnection,
    recordCaptureLimits,
} from '../src/recordConnection.ts';

// 実台帳・daemonには接続しない。必須引数が無ければ成功扱いせず終了する。
const canonicalRoot = process.argv[2];
if (!canonicalRoot) throw new Error('正式checkpointの隔離WTを指定してください');
const expected = '1cd5c8787d5434bb0c167d686ee7462f9d8b9077';
assert.equal(
    execFileSync('git', ['-C', canonicalRoot, 'rev-parse', 'HEAD'], {
        encoding: 'utf8',
    }).trim(),
    expected,
);
execFileSync('git', [
    '-C',
    canonicalRoot,
    'diff',
    '--quiet',
    'HEAD',
    '--',
    '.agents/skills/task-supervisor',
]);
const base = resolve(canonicalRoot, '.agents/skills/task-supervisor');
const load = (file: string) => import(pathToFileURL(join(base, file)).href);
const [
    { RuntimeStore },
    { makeBundle },
    { emptyRegistry },
    { parseRecordCommand, parseRecordRead },
    { parseRecordReadResult },
    { runtimeDirectory },
] = await Promise.all([
    load('runtime/store.ts'),
    load('migration/bundle.ts'),
    load('registry.ts'),
    load('runtime/record-protocol.ts'),
    load('runtime/record-values.ts'),
    load('runtime/files.ts'),
]);
const isolated = mkdtempSync(join(tmpdir(), 't341-record-connection-'));
using _cleanup = {
    [Symbol.dispose]() {
        rmSync(isolated, { recursive: true, force: true });
    },
};
const registry = emptyRegistry();
registry.tasks.push({
    id: 'T1',
    title: '隔離した接続検査',
    status: '実装中',
    tickets: [],
    branches: [],
    prs: [],
    sessions: [],
    related: [],
    notes: [],
    createdAt: 1,
    updatedAt: 1,
});
const command =
    "printf '%s\\n' '固定版の日本語 $HOME'\nprintf '%s\\n' 'stderr 原文' >&2\nexit 0\n";
registry.actions.push({
    id: 'U1',
    taskId: 'T1',
    kind: 'execution',
    command,
    executionWhere: 'devcontainer',
    text: '隔離fixture',
    done: false,
    createdAt: 1,
    needsOk: true,
});
registry.actions.push({ ...registry.actions[0], id: 'U2', needsOk: false });
registry.actions.push({ ...registry.actions[0], id: 'U3' });
registry.actions.push({ ...registry.actions[0], id: 'U4' });
registry.actions.push({ ...registry.actions[0], id: 'U5' });
registry.nextTaskNo = 2;
registry.nextActionNo = 6;
const bundle = makeBundle(
    {
        'registry.json': JSON.stringify(registry),
        'archive.json': null,
        'events.jsonl': '',
        'state.json': null,
    },
    100,
);
const runtime = runtimeDirectory(isolated);
using store = new RuntimeStore(join(runtime, 'state.sqlite'), {
    root: isolated,
    storageFormat: 3,
});
const decision = {
    schemaVersion: 1,
    mode: 'authoritative',
    epoch: 'isolated-epoch',
    migrationId: 'isolated-migration',
    fingerprint: bundle.fingerprint,
};
store.installLegacy(bundle, decision);
writeFileSync(join(runtime, 'authority.json'), JSON.stringify(decision));
// 本番の認可実装ではない。非機密printfだけを検査する人工の呼出しcontext。
const caller: RecordCaller = {
    subject: 'fixture-person',
    taskIds: ['T1'],
    privileges: [
        'documents.write',
        'documents.read',
        'executions.prepare',
        'executions.run',
        'executions.read',
        'executions.output.read',
        'executions.disclose',
    ],
    audience: 'person',
    runnerId: 'fixture-devcontainer',
    policyRef: 'fixture-only-policy',
    authorizeNonSensitiveCommand: () => true,
};
const submitted: RecordCommand[] = [];
const channel: RecordChannel = {
    async review(actionId) {
        const context = store.requestContext(actionId);
        assert.equal(context.request.taskId, 'T1');
        assert.equal(context.request.executionWhere, 'devcontainer');
        assert.equal(typeof context.request.command, 'string');
        return {
            targetId: context.request.taskId,
            input: {
                actionId: context.actionId,
                requestVersion: context.requestVersion,
            },
            command: context.request.command,
            taskVersion: context.taskVersion,
        };
    },
    async submit(c) {
        submitted.push(structuredClone(c));
        const result = store.apply(parseRecordCommand(c), Date.now(), caller);
        assert.equal(result.commandId, c.commandId);
        if (result.status === 'rejected')
            throw new KnownRecordRejection(
                result.message,
                result.code === 'version-conflict',
            );
        assert.equal(result.status, 'applied', result.message);
        assert.equal(result.code, 'ok');
        assert.ok(result.data?.record);
        return { record: result.data.record, taskVersion: result.version };
    },
    async read<Q extends RecordRead>(
        input: Q,
    ): Promise<RecordReadResult<Q['type']>> {
        const q = parseRecordRead(input);
        const result =
            q.type === 'document.read'
                ? store.documentRecord(
                      q.targetId,
                      q.documentId,
                      q.revision,
                      caller,
                  )
                : q.type === 'execution.read'
                  ? store.executionRecord(q.targetId, q.attemptId, caller)
                  : store.executionOutput(
                        q.targetId,
                        q.attemptId,
                        q.afterSeq,
                        caller,
                    );
        return parseRecordReadResult(q.type, result);
    },
};
const published = await channel.submit({
    schemaVersion: 1,
    commandId: 'fixture-document',
    targetId: 'T1',
    expectedVersion: store.currentVersion('T1'),
    source: 'untrusted-string',
    type: 'document.publish',
    payload: {
        expectedRevision: 0,
        title: '固定資料',
        body: '確認する資料の全文\n<script>原文</script>\n',
    },
});
const connection = new RecordConnection(
    channel,
    'T1',
    published.taskVersion,
    'extension-fixture',
);
assert.ok(published.record.document);
const document = await connection.document(
    published.record.document.documentId,
    published.record.document.revision,
);
const prepareReferences: RecordCommand[] = [];
const approval = {
    allowed: async () => true,
    confirm: async (
        preview: Readonly<import('../src/executionRunner.ts').ExecutionPreview>,
    ) => {
        assert.equal(preview.command, command);
        assert.equal(Object.isFrozen(preview), true);
        return true;
    },
    keepReference: async (c: Readonly<RecordCommand>) => {
        prepareReferences.push(structuredClone(c));
    },
};
const beforeCancel = submitted.length;
assert.equal(
    await connection.prepare(
        'U1',
        store.requestContext('U1').requestVersion,
        isolated,
        [document],
        { ...approval, confirm: async () => false },
    ),
    null,
);
assert.equal(submitted.length, beforeCancel);
assert.equal(prepareReferences.length, 0);
const context = await connection.prepare(
    'U1',
    store.requestContext('U1').requestVersion,
    isolated,
    [document],
    approval,
);
assert.ok(context);
assert.equal(context.preview.command, command);
assert.equal(context.preview.documents[0].body, document.body);
const access = connection.disclosure(
    context.attempt.attemptId,
    async () => true,
);
let view = await access.read();
assert.equal(view.aiDisclosure, 'denied');
await access.changeDisclosure(view.context, true);
assert.equal((await access.read()).aiDisclosure, 'allowed');
const reserved = new Set<string>();
let launches = 0;
const shown: string[] = [],
    warnings: string[] = [];
const ui: Parameters<RecordConnection['runner']>[0] = {
    allowed: async (c) => c.attempt.runnerId === caller.runnerId,
    reserveLocalLaunch: async (key) => {
        if (reserved.has(key)) return false;
        reserved.add(key);
        return true;
    },
    launch: (request) => {
        launches++;
        return nodeExecutionProcess(request, () => true);
    },
    status: () => {},
    showSaved: (p) => shown.push(p.text),
    warning: (m) => warnings.push(m),
};
const port = connection.runner(ui);
const runner = new ExecutionRunner(port, recordCaptureLimits);
const running = runner.run(context);
assert.equal(runner.run(context), running);
const result = await running;
assert.equal(result.state, 'ended', JSON.stringify({ result, warnings }));
assert.equal(result.facts?.output.status, 'complete');
assert.equal(launches, 1);
const saved = await connection.execution(context.attempt.attemptId);
assert.equal(saved.state.integrity, 'complete');
assert.equal(saved.state.result?.exitCode, 0);
assert.equal(shown.join('').includes('固定版の日本語 $HOME'), true);
assert.equal(shown.join('').includes('stderr 原文'), true);
const action = store
    .snapshot('fixture-process', Date.now())
    .registry.actions.find((a: { id: string }) => a.id === 'U1');
assert.equal(typeof action.ranAt, 'number');
assert.equal(action.done, false);
assert.equal(
    (await new ExecutionRunner(port, recordCaptureLimits).run(context)).state,
    'unknown',
);
assert.equal(launches, 1);
const output = submitted.find((c) => c.type === 'execution.output');
assert.ok(output);
const replay = store.apply(parseRecordCommand(output), Date.now(), caller);
assert.equal(replay.status, 'applied');
const mismatch = structuredClone(output);
if (mismatch.type === 'execution.output') mismatch.payload.body += 'different';
assert.equal(
    store.apply(parseRecordCommand(mismatch), Date.now(), caller).code,
    'id-conflict',
);
view = await access.read();
await access.changeDisclosure(view.context, false);
assert.equal((await access.read()).aiDisclosure, 'denied');
assert.throws(() =>
    store.executionOutput('T1', context.attempt.attemptId, 0, undefined),
);
const denied = {
    ...output,
    commandId: 'not-a-person',
    expectedVersion: store.currentVersion('T1'),
    source: 'person:true',
};
assert.equal(
    store.apply(parseRecordCommand(denied), Date.now(), undefined).status,
    'rejected',
);
const limitedConnection = new RecordConnection(
    channel,
    'T1',
    store.currentVersion('T1'),
    'limited-fixture',
);
const limitedContext = await limitedConnection.prepare(
    'U2',
    store.requestContext('U2').requestVersion,
    isolated,
    [],
    approval,
);
assert.ok(limitedContext);
const limitedPort = limitedConnection.runner({
    ...ui,
    allowed: async () => true,
});
const limitedResult = await new ExecutionRunner(limitedPort, {
    ...recordCaptureLimits,
    pieceBytes: 4,
    executionBytes: 8,
}).run(limitedContext);
assert.equal(limitedResult.state, 'ended');
assert.equal(limitedResult.facts?.output.status, 'incomplete');
const limitedSaved = await limitedConnection.execution(
    limitedContext.attempt.attemptId,
);
assert.equal(limitedSaved.state.integrity, 'incomplete');
assert.ok((limitedSaved.state.missingStdoutBytes ?? 0) > 0);
assert.ok((limitedSaved.state.missingStderrBytes ?? 0) > 0);
assert.equal(limitedSaved.state.result?.exitCode, 0);
const conflictConnection = new RecordConnection(
    channel,
    'T1',
    store.currentVersion('T1'),
    'conflict-fixture',
);
const conflictContext = await conflictConnection.prepare(
    'U3',
    store.requestContext('U3').requestVersion,
    isolated,
    [],
    approval,
);
assert.ok(conflictContext);
const concurrent = store.apply(
    {
        schemaVersion: 1,
        commandId: 'concurrent-change',
        targetId: 'T1',
        expectedVersion: store.currentVersion('T1'),
        source: 'fixture',
        type: 'session.observe',
        payload: {
            sessionId: 'fixture-session',
            generation: 1,
            state: 'running',
            observedAt: Date.now(),
        },
    },
    Date.now(),
);
assert.equal(concurrent.status, 'applied', concurrent.message);
const beforeConflictLaunches = launches;
const conflictResult = await new ExecutionRunner(
    conflictConnection.runner({
        ...ui,
        allowed: async () => true,
    }),
    recordCaptureLimits,
).run(conflictContext);
assert.equal(conflictResult.state, 'unknown');
assert.equal(launches, beforeConflictLaunches);
const deniedStartConnection = new RecordConnection(
    channel,
    'T1',
    store.currentVersion('T1'),
    'known-start-rejection',
);
const deniedStartContext = await deniedStartConnection.prepare(
    'U4',
    store.requestContext('U4').requestVersion,
    isolated,
    [],
    approval,
);
assert.ok(deniedStartContext);
const beforeStartWarnings = warnings.length;
const deniedStartPort = deniedStartConnection.runner({
    ...ui,
    launch: (request) => {
        const source = ui.launch(request);
        return {
            [Symbol.dispose]: () => source[Symbol.dispose](),
            observations: {
                async *[Symbol.asyncIterator]() {
                    for await (const event of source.observations)
                        yield event.kind === 'spawned'
                            ? { ...event, startedAt: 0 }
                            : event;
                },
            },
        };
    },
});
let deniedStartReadVerified = false;
const readStartFinished = deniedStartPort.readFinished;
deniedStartPort.readFinished = async (c) => {
    const saved = await readStartFinished(c);
    deniedStartReadVerified = true;
    return saved;
};
const deniedStartResult = await new ExecutionRunner(
    deniedStartPort,
    recordCaptureLimits,
).run(deniedStartContext);
assert.equal(deniedStartResult.state, 'unknown');
assert.equal(deniedStartReadVerified, true);
assert.ok(
    warnings
        .slice(beforeStartWarnings)
        .some((v) => v.includes('開始記録が確定拒否')),
);
assert.equal(
    warnings
        .slice(beforeStartWarnings)
        .some((v) => v.includes('起動事実の保存が不明')),
    false,
);
assert.deepEqual(deniedStartResult.facts?.termination, {
    kind: 'exit',
    code: 0,
});
const deniedStartSaved = await deniedStartConnection.execution(
    deniedStartContext.attempt.attemptId,
);
assert.equal(deniedStartSaved.state.status, 'unknown');
assert.equal(deniedStartSaved.state.result?.outcome, 'unknown');
assert.equal(deniedStartSaved.state.integrity, 'incomplete');
assert.ok((deniedStartSaved.state.missingStdoutBytes ?? 0) > 0);
const finalUnknown = submitted
    .slice()
    .reverse()
    .find(
        (c) =>
            c.type === 'execution.finished' &&
            c.payload.attemptId === deniedStartContext.attempt.attemptId,
    );
assert.ok(finalUnknown);
if (finalUnknown.type === 'execution.finished')
    assert.equal(finalUnknown.payload.outcome, 'unknown');
const deniedOutputChannel: RecordChannel = {
    ...channel,
    submit: async (c) => {
        if (c.type === 'execution.output')
            throw new KnownRecordRejection('人工の確定非適用');
        return channel.submit(c);
    },
};
const deniedOutputConnection = new RecordConnection(
    deniedOutputChannel,
    'T1',
    store.currentVersion('T1'),
    'known-output-rejection',
);
const deniedOutputContext = await deniedOutputConnection.prepare(
    'U5',
    store.requestContext('U5').requestVersion,
    isolated,
    [],
    approval,
);
assert.ok(deniedOutputContext);
const deniedOutputResult = await new ExecutionRunner(
    deniedOutputConnection.runner(ui),
    recordCaptureLimits,
).run(deniedOutputContext);
assert.equal(deniedOutputResult.state, 'ended');
assert.equal(deniedOutputResult.facts?.output.uncertainBytes, 0);
const deniedOutputSaved = await deniedOutputConnection.execution(
    deniedOutputContext.attempt.attemptId,
);
assert.equal(deniedOutputSaved.state.status, 'ended');
assert.equal(deniedOutputSaved.state.result?.exitCode, 0);
assert.equal(deniedOutputSaved.state.integrity, 'incomplete');
console.log(
    '正式checkpointのSQLite・実Bash・固定本文・seq保存後read・ranとdoneの分離・開示切替・二重起動防止を確認しました',
);
