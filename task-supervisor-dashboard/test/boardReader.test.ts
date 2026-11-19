import assert from 'node:assert/strict';
import {
    mkdir,
    mkdtemp,
    readFile,
    rename,
    rm,
    stat,
    utimes,
    writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { Ledger, revision } from '../src/boardClient.ts';
import { BOARD_FILES, BoardReader } from '../src/boardReader.ts';
import type { ActionGateway } from '../src/gateway.ts';
import { UserActionsUnavailable } from '../src/userActionsView.ts';
import {
    noOperations,
    readyView,
    viewRow,
    waitingForExecution,
} from './viewFixture.ts';

const directory = '.agents/ローカルタスク/監督';
const task = {
    id: 'T341',
    title: '表示の確認',
    status: '実装中',
    tickets: [],
    branches: [],
    prs: [],
    sessions: [],
    related: [],
    notes: [],
    createdAt: 1,
    updatedAt: 2,
};
const action = {
    id: 'U341',
    taskId: 'T341',
    text: '読取りを確認',
    command: 'echo 確認',
    done: false,
    createdAt: 3,
};
const initialRegistry = { version: 1, tasks: [task], actions: [action] };
const rows = {
    ...waitingForExecution,
    operations: { ...noOperations, execute: true, complete: true },
};
const legacyView = async () =>
    readyView([viewRow({ ...action, text: '共通CLIの依頼' }, rows, task)]);
const authority = {
    schemaVersion: 1,
    mode: 'authoritative',
    epoch: 'epoch-1',
    migrationId: 'migration-1',
    fingerprint: 'fingerprint-1',
};
async function fixture(t: TestContext) {
    const root = await mkdtemp(join(tmpdir(), 'board-reader-'));
    t.after(() => rm(root, { force: true, recursive: true }));
    const base = join(root, directory);
    await mkdir(join(base, 'runtime'), { recursive: true });
    const save = (name: string, value: unknown) =>
        writeFile(join(base, name), JSON.stringify(value));
    await save('registry.json', initialRegistry);
    await save('state.json', { facts: { warnings: ['観測キャッシュの注意'] } });
    await save('archive.json', { tasks: [] });
    await writeFile(
        join(base, 'events.jsonl'),
        `${JSON.stringify({ at: 4, taskId: task.id, kind: 'test', text: '出来事の原文', by: 'codex' })}\n`,
    );
    const gateway = async (): Promise<ActionGateway> =>
        new Ledger(
            root,
            async () => assert.fail('更新CLIが呼ばれた'),
            undefined,
            legacyView,
        );
    return {
        root,
        base,
        save,
        gateway,
        reader: new BoardReader(root, { gateway }),
    };
}
async function runtimeFixture(
    t: TestContext,
    mode: 'authoritative' | 'shadow' = 'authoritative',
) {
    const f = await fixture(t);
    const runtimeTask = { ...task, title: '常駐部が正本' };
    const runtimeAction = { ...action, text: '正本の依頼' };
    const snapshot = {
        schemaVersion: 1,
        mode,
        generation: 'process-1',
        registry: {
            ...initialRegistry,
            tasks: [runtimeTask],
            actions: initialRegistry.actions,
        },
        tasks: [{ id: task.id, version: 17 }],
        userActions: readyView([viewRow(runtimeAction, rows, runtimeTask)], {
            mode,
            epoch: mode === 'authoritative' ? authority.epoch : null,
            fetchedAt: 1000,
            error: null,
        }),
    };
    if (mode === 'authoritative')
        await f.save('runtime/authority.json', authority);
    await f.save('runtime/snapshot.json', snapshot);
    await f.save('runtime/heartbeat.json', {
        schemaVersion: 1,
        generation: 'process-1',
        at: Date.now(),
    });
    const gateway = async () =>
        assert.fail('常駐スナップショット取得で別の読取りが呼ばれた');
    const readLegacy = async () =>
        assert.fail('常駐スナップショット取得で旧CLIが呼ばれた');
    return {
        ...f,
        snapshot,
        gateway,
        reader: new BoardReader(f.root, { gateway, legacyView: readLegacy }),
    };
}

test('4原票を読み、原稿の注意・出来事・mtimeを投影する', async (t) => {
    const f = await fixture(t);
    const value = await f.reader.read();
    assert.equal(value.source, 'legacy');
    assert.ok(value.warnings.includes('観測キャッシュの注意'));
    assert.ok(JSON.stringify(value.sections).includes('出来事の原文'));
    assert.ok(JSON.stringify(value.sections).includes(task.title));
    assert.ok(JSON.stringify(value.sections).includes('共通CLIの依頼'));
    assert.ok(!JSON.stringify(value.sections).includes(action.text));
    const modificationTimes = await Promise.all(
        BOARD_FILES.slice(0, 4).map(
            async (path) => (await stat(join(f.root, path))).mtimeMs,
        ),
    );
    assert.equal(value.updatedAt, Math.max(...modificationTimes));
    assert.equal((await f.reader.read()).updatedAt, value.updatedAt);
});

test('旧経路の表示は指定された共通読取りを使い、操作ポートを開かない', async (t) => {
    const f = await fixture(t);
    let calls = 0;
    const reader = new BoardReader(f.root, {
        gateway: async () =>
            assert.fail('旧経路の明示読取りで操作ポートが呼ばれた'),
        legacyView: async () => {
            calls++;
            return legacyView();
        },
    });
    const value = await reader.read();
    assert.equal(calls, 1);
    assert.equal(
        value.userActions?.viewVersion,
        (await legacyView()).viewVersion,
    );
    assert.ok(JSON.stringify(value.sections).includes('共通CLIの依頼'));
});

test('任意3原票の不在は空値と警告、registry不在は失敗する', async (t) => {
    const f = await fixture(t);
    for (const name of ['state.json', 'archive.json', 'events.jsonl'])
        await rm(join(f.base, name));
    const value = await f.reader.read();
    for (const name of ['state.json', 'archive.json', 'events.jsonl'])
        assert.ok(value.warnings.some((warning) => warning.includes(name)));
    await rm(join(f.base, 'registry.json'));
    await assert.rejects(f.reader.read(), { code: 'ENOENT' });
});

test('任意原票の破損を空値として扱わない', async (t) => {
    for (const name of ['registry.json', 'state.json', 'archive.json']) {
        const f = await fixture(t);
        await writeFile(join(f.base, name), '{');
        await assert.rejects(f.reader.read());
    }
});

test('JSONL未完了末尾だけは完了行を保持し、途中破損は拒否する', async (t) => {
    const f = await fixture(t);
    const path = join(f.base, 'events.jsonl');
    const original = await readFile(path, 'utf8');
    await writeFile(path, `${original}{"at":`);
    const value = await f.reader.read();
    assert.ok(value.warnings.some((warning) => warning.includes('末尾')));
    assert.ok(JSON.stringify(value.sections).includes('出来事の原文'));
    await writeFile(path, `${original}{broken}\n${original}`);
    await assert.rejects(f.reader.read(), /2行目/);
    await writeFile(path, `${original}{broken}\n`);
    await assert.rejects(f.reader.read(), /2行目/);
});

test('切替準備中は旧台帳を返さず、消失後も戻さない', async (t) => {
    const f = await fixture(t);
    await f.save('runtime/authority.json', { ...authority, mode: 'preparing' });
    await assert.rejects(f.reader.read(), /切替準備中/);
    await rm(join(f.base, 'runtime/authority.json'));
    await assert.rejects(f.reader.read(), /消失/);
    await assert.rejects(
        new BoardReader(f.root, {
            gateway: f.gateway,
            authoritySeen: () => true,
        }).read(),
        /消失/,
    );
});

test('正本は共通の依頼と同じスナップショット内の更新用タスク版を投影する', async (t) => {
    const f = await runtimeFixture(t);
    await writeFile(
        join(f.base, 'registry.json'),
        '旧台帳は破損していても参照しない',
    );
    const value = await f.reader.read();
    assert.equal(value.source, 'authoritative');
    assert.ok(JSON.stringify(value.sections).includes('常駐部が正本'));
    assert.ok(JSON.stringify(value.sections).includes('正本の依頼'));
    assert.ok(!JSON.stringify(value.sections).includes(action.text));
    const card = value.sections
        .flatMap((section) => section.cards)
        .find((entry) => entry.id === action.id);
    assert.ok(card);
    const [row] = f.snapshot.userActions.rows;
    const target = {
        ...row.action,
        runtime: { epoch: authority.epoch, taskId: task.id, version: 17 },
    };
    assert.ok(card.operations.length > 0);
    assert.ok(
        card.operations.every(
            (operation) => operation.revision === revision(target),
        ),
    );
    await f.save('runtime/snapshot.json', {
        ...f.snapshot,
        userActions: {
            ...f.snapshot.userActions,
            viewVersion: '次の一覧の表示版',
            rows: [{ ...row, version: '次の行の表示版' }],
        },
    });
    const updated = await f.reader.read();
    const updatedCard = updated.sections
        .flatMap((section) => section.cards)
        .find((entry) => entry.id === card.id);
    assert.ok(updatedCard);
    assert.equal(updated.userActions?.viewVersion, '次の一覧の表示版');
    assert.ok(JSON.stringify(updatedCard.fields).includes('次の行の表示版'));
    assert.deepEqual(updatedCard.operations, card.operations);
    await rm(join(f.base, 'runtime/authority.json'));
    await assert.rejects(f.reader.read(), /消失/);
});

test('正本切替前はshadowを読み、一度読んだスナップショットの消失時は旧台帳へ戻さない', async (t) => {
    const f = await runtimeFixture(t, 'shadow');
    const value = await f.reader.read();
    assert.equal(value.source, 'shadow');
    assert.equal(value.userActions?.source.mode, 'shadow');
    assert.ok(JSON.stringify(value.sections).includes('正本の依頼'));
    await rm(join(f.base, 'runtime/snapshot.json'));
    await assert.rejects(f.reader.read(), /消失|ENOENT/);
});

test('正本スナップショットの欠落・破損・モードや世代の不一致では旧台帳へ戻さない', async (t) => {
    const f = await runtimeFixture(t);
    await rm(join(f.base, 'runtime/snapshot.json'));
    await assert.rejects(f.reader.read(), { code: 'ENOENT' });
    await writeFile(join(f.base, 'runtime/snapshot.json'), '{');
    await assert.rejects(f.reader.read());
    await f.save('runtime/snapshot.json', { ...f.snapshot, mode: 'shadow' });
    await assert.rejects(f.reader.read(), /正本スナップショット/);
    const view = f.snapshot.userActions;
    await f.save('runtime/snapshot.json', {
        ...f.snapshot,
        userActions: { ...view, source: { ...view.source, epoch: 'epoch-2' } },
    });
    await assert.rejects(f.reader.read(), /モード・世代が一致しません/);
});

test('heartbeat初回不在・古い・未来・異なる世代・破損では一覧の更新を拒否する', async (t) => {
    const f = await runtimeFixture(t);
    await rm(join(f.base, 'runtime/heartbeat.json'));
    await assert.rejects(f.reader.read(), /稼働|heartbeat/);
    for (const [at, generation] of [
        [Date.now() - 31_000, 'process-1'],
        [Date.now() + 60_000, 'process-1'],
        [Date.now(), 'process-2'],
    ] as const) {
        await f.save('runtime/heartbeat.json', {
            schemaVersion: 1,
            generation,
            at,
        });
        await assert.rejects(f.reader.read(), /稼働|heartbeat/);
    }
    await f.save('runtime/heartbeat.json', {
        schemaVersion: 1,
        generation: 'process-1',
        at: Date.now(),
        snapshotError: '最新スナップショットの保存に失敗',
    });
    await assert.rejects(f.reader.read(), /スナップショット保存結果/);
    await f.save('runtime/heartbeat.json', {
        schemaVersion: 1,
        generation: 'process-1',
        at: Date.now(),
    });
    assert.equal((await f.reader.read()).source, 'authoritative');
    await rm(join(f.base, 'runtime/heartbeat.json'));
    await assert.rejects(f.reader.read(), /稼働|heartbeat/);
    await writeFile(join(f.base, 'runtime/heartbeat.json'), '{');
    await assert.rejects(f.reader.read());
});

test('スナップショット取得中に置換されれば再読取りし、置換後の版を返す', async (t) => {
    const f = await runtimeFixture(t);
    let calls = 0;
    const value = await new BoardReader(f.root, {
        gateway: f.gateway,
        markAuthorityObserved: async () => {
            calls++;
            if (calls === 1) {
                const next = {
                    ...f.snapshot,
                    registry: {
                        ...f.snapshot.registry,
                        tasks: [{ ...task, title: '置換後の正本' }],
                    },
                    userActions: {
                        ...f.snapshot.userActions,
                        viewVersion: '置換後の一覧版',
                    },
                };
                await f.save('runtime/next.json', next);
                await rename(
                    join(f.base, 'runtime/next.json'),
                    join(f.base, 'runtime/snapshot.json'),
                );
            }
        },
    }).read();
    assert.ok(calls >= 3);
    assert.ok(JSON.stringify(value.sections).includes('置換後の正本'));
    assert.equal(value.userActions?.viewVersion, '置換後の一覧版');
});

test('mtimeは実ファイル更新に追従し、読取り時刻で進めない', async (t) => {
    const f = await fixture(t);
    const fixed = new Date(1_700_000_000_000);
    for (const path of BOARD_FILES.slice(0, 4))
        await utimes(join(f.root, path), fixed, fixed);
    assert.equal((await f.reader.read()).updatedAt, fixed.getTime());
    const next = new Date(fixed.getTime() + 123_000);
    await utimes(join(f.base, 'state.json'), next, next);
    assert.equal((await f.reader.read()).updatedAt, next.getTime());
});

test('破損した切替記録を見た後も旧台帳へ戻さない', async (t) => {
    const f = await fixture(t);
    await writeFile(join(f.base, 'runtime/authority.json'), '{');
    await assert.rejects(f.reader.read());
    await rm(join(f.base, 'runtime/authority.json'));
    await assert.rejects(f.reader.read(), /消失/);
});

test('旧共通読取りの失敗を空の成功表示へ変換しない', async (t) => {
    const f = await fixture(t);
    const reader = new BoardReader(f.root, {
        gateway: async () => {
            throw new Error('最新情報の取得失敗');
        },
    });
    await assert.rejects(reader.read(), /最新情報の取得失敗/);
});

test('共通一覧の取得失敗をエラーの版・理由・前回取得時刻付きで返す', async (t) => {
    const f = await runtimeFixture(t);
    const view = {
        ...f.snapshot.userActions,
        status: 'unavailable',
        viewVersion: '失敗時の表示版',
        source: {
            ...f.snapshot.userActions.source,
            error: {
                code: 'SOURCE_UNAVAILABLE',
                message: '共通一覧を取得できません',
            },
        },
        rows: null,
    };
    await f.save('runtime/snapshot.json', { ...f.snapshot, userActions: view });
    await assert.rejects(f.reader.read(), (error) => {
        assert.ok(error instanceof UserActionsUnavailable);
        assert.deepEqual(error.view, view);
        return true;
    });
});

test('正本のepochが読取り中に変われば最新版で再取得する', async (t) => {
    const f = await runtimeFixture(t);
    const observed: string[] = [];
    const reader = new BoardReader(f.root, {
        gateway: f.gateway,
        markAuthorityObserved: async (epoch) => {
            observed.push(epoch);
            if (observed.length !== 1) return;
            const next = 'epoch-2';
            const view = f.snapshot.userActions;
            await f.save('runtime/next-snapshot.json', {
                ...f.snapshot,
                userActions: {
                    ...view,
                    source: { ...view.source, epoch: next },
                },
            });
            await f.save('runtime/next-authority.json', {
                ...authority,
                epoch: next,
            });
            await rename(
                join(f.base, 'runtime/next-snapshot.json'),
                join(f.base, 'runtime/snapshot.json'),
            );
            await rename(
                join(f.base, 'runtime/next-authority.json'),
                join(f.base, 'runtime/authority.json'),
            );
        },
    });
    const value = await reader.read();
    assert.equal(value.source, 'authoritative');
    assert.equal(value.userActions?.source.epoch, 'epoch-2');
    assert.equal(observed[0], authority.epoch);
    assert.equal(observed.at(-1), 'epoch-2');
});

test('正本のスナップショットだけを観測しても旧経路への復帰を永続的に拒否する', async (t) => {
    const f = await runtimeFixture(t);
    await rm(join(f.base, 'runtime/authority.json'));
    const observed: string[] = [];
    const options = {
        gateway: f.gateway,
        authoritySeen: () => observed.length > 0,
        markAuthorityObserved: async (epoch: string) => {
            observed.push(epoch);
        },
    };
    await assert.rejects(
        new BoardReader(f.root, options).read(),
        /切替記録が消失/,
    );
    assert.deepEqual(observed, ['snapshot-authoritative']);
    await rm(join(f.base, 'runtime/snapshot.json'));
    await assert.rejects(
        new BoardReader(f.root, options).read(),
        /切替記録が消失/,
    );
});

test('リポジトリURLを投影へ渡し、観測未取得のPRリンクを解決する', async (t) => {
    const f = await fixture(t);
    await f.save('registry.json', {
        ...initialRegistry,
        tasks: [{ ...task, prs: [341] }],
    });
    const value = await new BoardReader(f.root, {
        gateway: f.gateway,
        repoUrl: 'https://github.com/example/project',
    }).read();
    const links = value.sections.flatMap((section) =>
        section.cards.flatMap((card) => [
            ...card.links,
            ...card.fields.flatMap((field) =>
                field.parts.flatMap((part) => (part.link ? [part.link] : [])),
            ),
        ]),
    );
    assert.ok(
        links.some(
            (link) =>
                link.target.kind === 'external' &&
                link.target.uri ===
                    'https://github.com/example/project/pull/341',
        ),
    );
});

for (const name of ['state.json', 'archive.json', 'events.jsonl']) {
    test(`既読の${name}が消失したとき空表示へ置換しない`, async (t) => {
        const f = await fixture(t);
        const before = await f.reader.read();
        const original = await readFile(join(f.base, name), 'utf8');
        await rm(join(f.base, name));
        await assert.rejects(f.reader.read(), { code: 'ENOENT' });
        await writeFile(join(f.base, name), original);
        assert.deepEqual((await f.reader.read()).sections, before.sections);
    });
}

for (const observation of [
    'preparing',
    'unreadable',
    'snapshot-missing',
    'snapshot-corrupt',
]) {
    test(`${observation}を永続観測しReader再生成後も旧台帳へ戻さない`, async (t) => {
        const f = await fixture(t);
        let stored: string | undefined;
        const observations: string[] = [];
        let gatewayCalls = 0;
        const options = {
            gateway: async () => {
                gatewayCalls++;
                return f.gateway();
            },
            authoritySeen: () => stored !== undefined,
            markAuthorityObserved: async (epoch: string) => {
                await Promise.resolve();
                stored = epoch;
                observations.push(epoch);
            },
        };
        if (observation === 'unreadable')
            await writeFile(join(f.base, 'runtime/authority.json'), '{');
        else
            await f.save('runtime/authority.json', {
                ...authority,
                mode:
                    observation === 'preparing' ? 'preparing' : 'authoritative',
            });
        if (observation === 'snapshot-corrupt')
            await writeFile(join(f.base, 'runtime/snapshot.json'), '{');
        await assert.rejects(new BoardReader(f.root, options).read());
        assert.equal(
            stored,
            observation === 'unreadable' ? 'unreadable' : authority.epoch,
        );
        assert.equal(gatewayCalls, 0);
        assert.deepEqual(observations, [stored]);
        await rm(join(f.base, 'runtime/authority.json'));
        await assert.rejects(new BoardReader(f.root, options).read(), /消失/);
    });
}

test('切替観測の永続化完了を待ってから準備中の読取りを拒否する', async (t) => {
    const f = await fixture(t);
    await f.save('runtime/authority.json', { ...authority, mode: 'preparing' });
    let started = () => {};
    const entered = new Promise<void>((resolve) => {
        started = resolve;
    });
    let release = () => {};
    const saving = new Promise<void>((resolve) => {
        release = resolve;
    });
    let settled = false;
    const reader = new BoardReader(f.root, {
        gateway: f.gateway,
        markAuthorityObserved: async () => {
            started();
            await saving;
        },
    });
    const reading = reader.read().finally(() => {
        settled = true;
    });
    const rejected = assert.rejects(reading, /切替準備中/);
    await entered;
    await setImmediate();
    assert.equal(settled, false);
    release();
    await rejected;
});
