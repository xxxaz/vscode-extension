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
import { Ledger, revision } from '../src/boardClient.ts';
import { BOARD_FILES, BoardReader } from '../src/boardReader.ts';
import type { ActionGateway } from '../src/gateway.ts';
import { runtimeIO } from '../src/runtimeFiles.ts';
import { RuntimeGateway } from '../src/runtimeGateway.ts';

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
        new Ledger(root, async () => {
            throw new Error('読取りでCLIは実行しません');
        });
    return {
        root,
        base,
        save,
        gateway,
        reader: new BoardReader(root, { gateway }),
    };
}
async function runtimeFixture(t: TestContext) {
    const f = await fixture(t);
    const snapshot = {
        schemaVersion: 1,
        mode: 'authoritative',
        generation: 'process-1',
        registry: {
            ...initialRegistry,
            tasks: [{ ...task, title: '常駐部が正本' }],
            actions: [{ ...action, text: '正本の依頼' }],
        },
        tasks: [{ id: task.id, version: 17 }],
    };
    await f.save('runtime/authority.json', authority);
    await f.save('runtime/snapshot.json', snapshot);
    await f.save('runtime/heartbeat.json', {
        schemaVersion: 1,
        generation: 'process-1',
        at: Date.now(),
    });
    const io = runtimeIO(f.root, async () => {
        throw new Error('CLI呼出し禁止');
    });
    const gateway = async (): Promise<ActionGateway> =>
        new RuntimeGateway(f.root, authority.epoch, {
            ...io,
            authority: async () =>
                JSON.parse(
                    await readFile(
                        join(f.base, 'runtime/authority.json'),
                        'utf8',
                    ),
                ),
            journal: { get: () => undefined, set: async () => {} },
        });
    return {
        ...f,
        snapshot,
        gateway,
        reader: new BoardReader(f.root, { gateway }),
    };
}

test('4原票を読み、原稿の注意・出来事・mtimeを投影する', async (t) => {
    const f = await fixture(t);
    const value = await f.reader.read();
    assert.equal(value.source, 'legacy');
    assert.ok(value.warnings.includes('観測キャッシュの注意'));
    assert.ok(JSON.stringify(value.sections).includes('出来事の原文'));
    assert.ok(JSON.stringify(value.sections).includes(task.title));
    const mtimes = await Promise.all(
        BOARD_FILES.slice(0, 4).map(
            async (path) => (await stat(join(f.root, path))).mtimeMs,
        ),
    );
    assert.equal(value.updatedAt, Math.max(...mtimes));
    assert.equal((await f.reader.read()).updatedAt, value.updatedAt);
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

test('正本では旧registryを読まずgatewayと同じ版の操作を投影する', async (t) => {
    const f = await runtimeFixture(t);
    await writeFile(
        join(f.base, 'registry.json'),
        '旧台帳は破損していても参照しない',
    );
    const value = await f.reader.read();
    assert.equal(value.source, 'authoritative');
    assert.ok(JSON.stringify(value.sections).includes('常駐部が正本'));
    assert.ok(JSON.stringify(value.sections).includes('正本の依頼'));
    const selected = (await (await f.gateway()).read()).actions[0];
    const operations = value.sections.flatMap((section) =>
        section.cards.flatMap((card) => card.operations),
    );
    assert.ok(operations.length > 0);
    assert.ok(
        operations.every(
            (operation) => operation.revision === revision(selected),
        ),
    );
    await rm(join(f.base, 'runtime/authority.json'));
    await assert.rejects(f.reader.read(), /消失/);
});

test('正本snapshot不在・破損・モード不一致で旧台帳へ戻さない', async (t) => {
    const f = await runtimeFixture(t);
    await rm(join(f.base, 'runtime/snapshot.json'));
    await assert.rejects(f.reader.read(), { code: 'ENOENT' });
    await writeFile(join(f.base, 'runtime/snapshot.json'), '{');
    await assert.rejects(f.reader.read());
    await f.save('runtime/snapshot.json', { ...f.snapshot, mode: 'shadow' });
    await assert.rejects(f.reader.read(), /正本スナップショット/);
});

test('heartbeat不在・古い・未来は保存済みの正本を参考表示し、破損は拒否する', async (t) => {
    const f = await runtimeFixture(t);
    for (const at of [Date.now() - 31_000, Date.now() + 60_000]) {
        await f.save('runtime/heartbeat.json', {
            schemaVersion: 1,
            generation: 'process-1',
            at,
        });
        const value = await f.reader.read();
        assert.equal(value.source, 'authoritative');
        assert.ok(
            value.warnings.some((warning) => warning.includes('参考表示')),
        );
    }
    await rm(join(f.base, 'runtime/heartbeat.json'));
    assert.ok(
        (await f.reader.read()).warnings.some((warning) =>
            warning.includes('参考表示'),
        ),
    );
    await writeFile(join(f.base, 'runtime/heartbeat.json'), '{');
    await assert.rejects(f.reader.read());
});

test('gateway取得中のsnapshot置換は再試行し、一致する最新版を返す', async (t) => {
    const f = await runtimeFixture(t);
    let calls = 0;
    const baseGateway = await f.gateway();
    const gateway: ActionGateway = {
        root: f.root,
        read: async () => {
            calls++;
            if (calls === 1) {
                const next = {
                    ...f.snapshot,
                    registry: {
                        ...f.snapshot.registry,
                        tasks: [{ ...task, title: '置換後の正本' }],
                    },
                };
                await f.save('runtime/next.json', next);
                await rename(
                    join(f.base, 'runtime/next.json'),
                    join(f.base, 'runtime/snapshot.json'),
                );
            }
            return baseGateway.read();
        },
        complete: baseGateway.complete.bind(baseGateway),
        answerContext: baseGateway.answerContext.bind(baseGateway),
        answer: baseGateway.answer.bind(baseGateway),
        hasAnswer: baseGateway.hasAnswer.bind(baseGateway),
    };
    const value = await new BoardReader(f.root, {
        gateway: async () => gateway,
    }).read();
    assert.ok(calls >= 2);
    assert.ok(JSON.stringify(value.sections).includes('置換後の正本'));
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

test('gatewayの取得失敗を空の成功表示へ変換しない', async (t) => {
    const f = await runtimeFixture(t);
    const reader = new BoardReader(f.root, {
        gateway: async () => {
            throw new Error('最新情報の取得失敗');
        },
    });
    await assert.rejects(reader.read(), /最新情報の取得失敗/);
});

test('正本のepochが読取り中に変われば最新版で再取得する', async (t) => {
    const f = await runtimeFixture(t);
    let calls = 0;
    let epoch = authority.epoch;
    const reader = new BoardReader(f.root, {
        gateway: async () => {
            calls++;
            if (calls === 1) {
                epoch = 'epoch-2';
                await f.save('runtime/authority.json', { ...authority, epoch });
            }
            const gateway = await f.gateway();
            return {
                root: gateway.root,
                read: async () => ({
                    ...f.snapshot.registry,
                    actions: f.snapshot.registry.actions.map((row) => ({
                        ...row,
                        runtime: { epoch, taskId: task.id, version: 17 },
                    })),
                }),
                complete: gateway.complete.bind(gateway),
                answerContext: gateway.answerContext.bind(gateway),
                answer: gateway.answer.bind(gateway),
                hasAnswer: gateway.hasAnswer.bind(gateway),
            };
        },
    });
    const value = await reader.read();
    assert.equal(value.source, 'authoritative');
    assert.ok(calls >= 2);
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
