#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
    boardRunner,
    commonView,
    Ledger,
    type PendingAnswer,
    type Registry,
} from '../src/boardClient.ts';

const board = process.argv[2];
if (!board)
    throw new Error(
        '共通読取りとanswerに対応したboard.tsのパスを指定してください',
    );
const root = await mkdtemp(join(tmpdir(), 'supervisor-real-cli-'));
await using _cleanup = {
    async [Symbol.asyncDispose]() {
        await rm(root, { recursive: true, force: true });
    },
};
const dir = join(root, '.agents/ローカルタスク/監督');
await mkdir(dir, { recursive: true });
await writeFile(
    join(dir, 'registry.json'),
    JSON.stringify({
        version: 1,
        nextTaskNo: 2,
        nextActionNo: 3,
        ignored: [],
        tasks: [
            {
                id: 'T1',
                title: '隔離検証',
                status: '実装中',
                tickets: [],
                branches: [],
                prs: [],
                sessions: [],
                related: [],
                notes: [],
                createdAt: 1,
                updatedAt: 1,
            },
        ],
        actions: [
            {
                id: 'U1',
                taskId: 'T1',
                text: '隔離実行依頼',
                kind: 'execution',
                command: 'echo test',
                done: false,
                needsOk: true,
                createdAt: 1,
            },
            {
                id: 'U2',
                taskId: 'T1',
                text: '隔離判断依頼',
                kind: 'decision',
                done: false,
                createdAt: 1,
            },
        ],
    }),
);
const ledger = new Ledger(
    root,
    boardRunner(root, process.execPath, resolve(board)),
);
const action = (registry: Registry, id: string) => {
    const selected = registry.actions.find((value) => value.id === id);
    assert.ok(selected, `隔離台帳に依頼 ${id} がありません`);
    return selected;
};
const initial = await ledger.read().catch((error: unknown) => {
    if (
        error instanceof Error &&
        (('code' in error && error.code === 2) ||
            ('stderr' in error &&
                typeof error.stderr === 'string' &&
                error.stderr.trim() === '--json に値がありません'))
    )
        throw new Error(
            '指定されたboard.tsは共通の読取りコマンド user-actions --json に未対応です',
        );
    throw error;
});
const initialRows = commonView(initial).rows;
assert.equal(
    initialRows.find((row) => row.id === 'U1')?.lifecycle,
    'unexecuted',
);
assert.equal(initialRows.find((row) => row.id === 'U2')?.lifecycle, 'decision');
await ledger.complete(action(initial, 'U1'), 'ran');
const ran = await ledger.read();
const awaiting = commonView(ran).rows.find((row) => row.id === 'U1');
assert.equal(awaiting?.lifecycle, 'awaiting-result');
assert.equal(awaiting.operations.confirmResult, true);
await ledger.complete(action(ran, 'U1'), 'complete');
const completed = await ledger.read();
assert.equal(
    commonView(completed).rows.find((row) => row.id === 'U1')?.lifecycle,
    'completed',
);
const ctx = await ledger.answerContext(action(completed, 'U2'));
const p: PendingAnswer = {
    id: 'U2',
    answer: '  原文\n`$(実行しない)`  ',
    respondent: '検証利用者',
    requestVersion: ctx.requestVersion,
    commandId: 'isolated-answer',
    confirmedResult: false,
};
await ledger.answer(p);
await ledger.answer(p);
assert.equal(await ledger.hasAnswer(p), true);
assert.equal(action(await ledger.read(), 'U2').answers?.length, 1);
console.log(
    '隔離台帳と実board.tsでキック済み・結果確認OK・自由回答原文・同一ID再送の読戻しを確認しました',
);
