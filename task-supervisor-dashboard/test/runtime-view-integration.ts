#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { type TestContext, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { candidates } from '../src/boardClient.ts';
import {
    readAuthority,
    runtimeIO,
    runtimeRelative,
} from '../src/runtimeFiles.ts';
import {
    type Authority,
    type PendingRuntime,
    type RuntimeCommand,
    RuntimeGateway,
    type RuntimePorts,
    type RuntimeResult,
    type RuntimeSnapshot,
    snapshotRegistry,
} from '../src/runtimeGateway.ts';
import {
    parseUserActionsView,
    UserActionsUnavailable,
    type UserActionsView,
} from '../src/userActionsView.ts';

type CandidateSnapshot = RuntimeSnapshot & { userActions: UserActionsView };
type Bundle = { fingerprint: string };
type Store = Disposable & {
    importRegistry(registry: RuntimeSnapshot['registry'], at: number): void;
    observationFailed(message: string): void;
    installLegacy(bundle: Bundle, authority: Authority): void;
    snapshot(generation: string, at: number): CandidateSnapshot;
    capabilities(): Awaited<ReturnType<RuntimePorts['capabilities']>>;
    apply(command: object, at: number): RuntimeResult;
};
type ProjectInput =
    | {
          registry: RuntimeSnapshot['registry'];
          source: Extract<UserActionsView, { status: 'ready' }>['source'];
      }
    | {
          registry: null;
          source: Extract<UserActionsView, { status: 'unavailable' }>['source'];
      };

const skillDirectory = process.argv[2];
if (!skillDirectory || process.argv.length !== 3)
    throw new Error(
        '使い方は node test/runtime-view-integration.ts <公開候補の監督skillディレクトリ> です',
    );
const directory = resolve(skillDirectory);
const load = async <T>(path: string): Promise<T> =>
    (await import(pathToFileURL(join(directory, path)).href)) as T;

const { RuntimeStore } = await load<{
    RuntimeStore: new (path: string, options: { root: string }) => Store;
}>('runtime/store.ts');
const { projectUserActions } = await load<{
    projectUserActions(input: ProjectInput): UserActionsView;
}>('user-actions/project.ts');
const { makeBundle } = await load<{
    makeBundle(
        files: Record<
            'registry.json' | 'archive.json' | 'events.jsonl' | 'state.json',
            string | null
        >,
        at: number,
    ): Bundle;
}>('migration/bundle.ts');
const { parseCommand } = await load<{
    parseCommand(command: unknown): object;
}>('runtime/protocol.ts');

const observedAt = 1_000_000;
const generation = 'isolated-snapshot';
const taskId = 'T1';
const actionId = 'U1';
const registry = {
    version: 1,
    nextTaskNo: 2,
    nextActionNo: 6,
    ignored: [],
    tasks: [
        {
            id: taskId,
            title: '隔離結合試験',
            status: '実装中',
            tickets: [],
            branches: [],
            prs: [],
            sessions: [],
            related: [],
            notes: [],
            createdAt: observedAt,
            updatedAt: observedAt,
        },
    ],
    actions: [
        { id: actionId, text: '結果確認が必要な実行依頼', needsOk: true },
        { id: 'U2', text: '実行済みの一般依頼', ranAt: observedAt },
        { id: 'U3', text: '保留中の依頼', holdReason: '隔離fixtureの保留' },
        { id: 'U4', text: '前提が未完了の依頼', after: ['U2'] },
        { id: 'U5', text: '判断依頼', kind: 'decision' as const },
    ].map((action) => ({
        taskId,
        kind: 'execution' as const,
        createdAt: observedAt,
        done: false,
        ...action,
    })),
};

async function fixture(t: TestContext) {
    const root = await mkdtemp(join(tmpdir(), 'supervisor-runtime-view-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const runtime = join(root, runtimeRelative);
    await mkdir(runtime, { recursive: true });
    return { root, runtime, dbPath: join(runtime, 'state.sqlite') };
}

await test('並行運転の実Snapshotで取得失敗を正常な空一覧と区別する', async (t) => {
    const { root, dbPath } = await fixture(t);
    using store = new RuntimeStore(dbPath, { root });
    store.importRegistry(registry, observedAt);
    const ready = store.snapshot(generation, observedAt + 1);
    assert.deepEqual(
        snapshotRegistry(ready).userActions,
        projectUserActions({
            registry,
            source: {
                mode: 'shadow',
                epoch: null,
                fetchedAt: observedAt,
                error: null,
            },
        }),
    );
    store.observationFailed('隔離fixtureの取得失敗');
    const failure = store.snapshot(generation, observedAt + 2);
    assert.throws(
        () => snapshotRegistry(failure),
        (error: unknown) => {
            assert.ok(error instanceof UserActionsUnavailable);
            assert.deepEqual(
                error.view,
                projectUserActions({
                    registry: null,
                    source: {
                        mode: 'shadow',
                        epoch: null,
                        fetchedAt: observedAt,
                        error: {
                            code: 'registry-observation-failed',
                            message: '隔離fixtureの取得失敗',
                        },
                    },
                }),
            );
            return true;
        },
    );
    store.importRegistry({ ...registry, actions: [] }, observedAt + 3);
    const empty = snapshotRegistry(store.snapshot(generation, observedAt + 4));
    assert.equal(empty.userActions?.status, 'ready');
    assert.deepEqual(empty.userActions.rows, []);
    assert.deepEqual(empty.actions, []);
});

await test('SQLite正本と拡張で表示版が一致し、操作受付は数値のタスク版を使う', async (t) => {
    const { root, runtime, dbPath } = await fixture(t);
    using store = new RuntimeStore(dbPath, { root });
    const bundle = makeBundle(
        {
            'registry.json': JSON.stringify(registry),
            'archive.json': null,
            'events.jsonl': null,
            'state.json': null,
        },
        observedAt,
    );
    const authority: Authority = {
        schemaVersion: 1,
        mode: 'authoritative',
        epoch: 'isolated-epoch',
        migrationId: 'isolated-migration',
        fingerprint: bundle.fingerprint,
    };
    await writeFile(join(runtime, 'authority.json'), JSON.stringify(authority));
    store.installLegacy(bundle, authority);
    const resultDirectory = join(runtime, 'results');
    await mkdir(resultDirectory);
    let at = observedAt + 1;
    const publish = async () => {
        const snapshot = store.snapshot(generation, at);
        await writeFile(
            join(runtime, 'snapshot.json'),
            JSON.stringify(snapshot),
        );
        return snapshot;
    };
    const initial = await publish();
    const io = runtimeIO(root, async () =>
        assert.fail('隔離結合試験からCLIは起動しません'),
    );
    let pending: PendingRuntime | undefined;
    const submitted: RuntimeCommand[] = [];
    const gateway = new RuntimeGateway(root, authority.epoch, {
        authority: () => readAuthority(root),
        snapshot: io.snapshot,
        capabilities: async () => store.capabilities(),
        submit: async (command) => {
            submitted.push(command);
            const result = store.apply(parseCommand(command), ++at);
            const resultPath = join(
                resultDirectory,
                `${command.commandId}.json`,
            );
            await writeFile(resultPath, JSON.stringify(result));
            await publish();
            return {
                commandId: command.commandId,
                status: 'queued',
                resultPath,
            };
        },
        result: io.result,
        answerContext: async () =>
            assert.fail('この試験では回答を書き込みません'),
        journal: {
            get: () => pending,
            set: async (value) => {
                pending = value;
            },
        },
    });
    const first = await gateway.read();
    assert.deepEqual(first, snapshotRegistry(initial, authority.epoch));
    const expected = projectUserActions({
        registry,
        source: {
            mode: 'authoritative',
            epoch: authority.epoch,
            fetchedAt: at,
            error: null,
        },
    });
    assert.deepEqual(first.userActions, expected);
    assert.ok(expected.status === 'ready');
    assert.match(expected.viewVersion, /^[a-f0-9]{64}$/);
    const initialRow = expected.rows.find((row) => row.id === actionId);
    assert.ok(initialRow);
    assert.match(initialRow.version, /^[a-f0-9]{64}$/);
    assert.deepEqual(
        candidates(first, 'complete')
            .map(({ id }) => id)
            .sort(),
        ['U2', 'U5'],
    );
    assert.deepEqual(
        candidates(first, 'answer').map(({ id }) => id),
        ['U5'],
    );
    const execution = candidates(first, 'ran');
    assert.deepEqual(
        execution.map(({ id }) => id),
        [actionId],
    );
    const firstSelection = execution[0];
    const taskVersion = initial.tasks[0].version;
    assert.equal(firstSelection.runtime?.version, taskVersion);

    const changed = store.apply(
        parseCommand({
            schemaVersion: 1,
            commandId: 'isolated-report',
            targetId: taskId,
            expectedVersion: taskVersion,
            source: 'runtime-view-integration',
            type: 'report.record',
            payload: {
                current: '台帳の表示内容を変えずにタスク版を進める',
                evidence: ['SQLite内の報告'],
                unresolved: [],
                nextOwner: '隔離fixture',
                next: {
                    kind: 'operation',
                    description: '依頼の結果を確認する',
                },
            },
        }),
        ++at,
    );
    assert.equal(changed.status, 'applied');
    const afterReport = await publish();
    assert.equal(afterReport.tasks[0].version, taskVersion + 1);
    assert.equal(afterReport.userActions.viewVersion, expected.viewVersion);
    await assert.rejects(
        gateway.complete(firstSelection, 'ran'),
        /依頼またはタスクの版が変わりました/,
    );
    assert.equal(submitted.length, 0);

    const [latest] = candidates(await gateway.read(), 'ran');
    await gateway.complete(latest, 'ran');
    assert.equal(submitted.length, 1);
    assert.equal(submitted[0].type, 'action.executed');
    assert.equal(submitted[0].expectedVersion, taskVersion + 1);
    assert.equal(submitted[0].targetId, taskId);
    assert.deepEqual(submitted[0].payload, { actionId });
    assert.equal(pending, undefined);
    const afterExecution = await io.snapshot();
    const view = parseUserActionsView(afterExecution.userActions);
    assert.deepEqual(
        view,
        projectUserActions({
            registry: afterExecution.registry,
            source: {
                mode: 'authoritative',
                epoch: authority.epoch,
                fetchedAt: at,
                error: null,
            },
        }),
    );
    assert.ok(view.status === 'ready');
    assert.notEqual(view.viewVersion, expected.viewVersion);
    const executed = view.rows.find((row) => row.id === actionId);
    assert.equal(executed?.lifecycle, 'awaiting-result');
    assert.notEqual(executed.version, initialRow.version);
    assert.ok(
        candidates(await gateway.read(), 'complete').some(
            ({ id }) => id === actionId,
        ),
    );
});
