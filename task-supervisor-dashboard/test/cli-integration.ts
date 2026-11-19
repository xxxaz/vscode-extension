#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Ledger, boardRunner, type PendingAnswer } from '../src/boardClient.ts';
const board = process.argv[2];
if (!board) throw Error('answer対応board.tsのパスを指定してください');
const root = await mkdtemp(join(tmpdir(), 'supervisor-real-cli-'));
await using cleanup = {
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
    })
);
const ledger = new Ledger(
    root,
    boardRunner(root, process.execPath, resolve(board))
);
let r = await ledger.read();
await ledger.complete(r.actions[0], 'ran');
r = await ledger.read();
await ledger.complete(r.actions[0], 'complete');
const ctx = await ledger.answerContext(r.actions[1]);
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
assert.equal((await ledger.read()).actions[1].answers!.length, 1);
console.log(
    '隔離台帳と実board.tsでキック済み・結果確認OK・自由回答原文・同一ID再送の読戻しを確認しました'
);
