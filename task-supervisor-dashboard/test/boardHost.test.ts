import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { type Interaction, record } from '../src/actions.ts';
import {
    type Action,
    type PendingAnswer,
    revision,
} from '../src/boardClient.ts';
import { BoardFeed } from '../src/boardFeed.ts';
import {
    findBoardLink,
    hasBoardOperation,
    parseBoardMessage,
    resolveBoardTarget,
} from '../src/boardHost.ts';
import type { BoardSnapshot, BoardUpdate } from '../src/dashboardTypes.ts';
import type { ActionGateway } from '../src/gateway.ts';

function snapshot(updatedAt = 1): BoardSnapshot {
    return {
        schemaVersion: 1,
        source: 'legacy',
        updatedAt,
        warnings: [],
        sections: [],
        counts: [],
    };
}
test('原票の更新が読取り中に続いても並行読取りせず最新まで取り直す', async () => {
    let finish: (value: BoardSnapshot) => void = () => {};
    let reads = 0;
    const messages: BoardUpdate[] = [];
    const feed = new BoardFeed(async () => {
        reads++;
        return reads === 1
            ? new Promise((resolve) => {
                  finish = resolve;
              })
            : snapshot(2);
    });
    feed.subscribe((value) => messages.push(value));
    const done = feed.refresh();
    feed.request();
    feed.request();
    feed.request();
    finish(snapshot(1));
    await done;
    assert.equal(reads, 2);
    assert.equal(feed.current?.updatedAt, 2);
    assert.equal(messages.length, 2);
    await feed.refresh();
    assert.equal(messages.length, 2);
    feed.dispose();
});
test('連続通知をまとめて読み、失敗では前回の行と更新時刻を保ち復旧で警告を消す', async () => {
    let reads = 0,
        failure = false;
    const feed = new BoardFeed(async () => {
        reads++;
        if (failure) throw new Error('JSON破損');
        return snapshot(7);
    }, 1);
    feed.subscribe(() => {});
    feed.request();
    feed.request();
    feed.request();
    await delay(20);
    assert.equal(reads, 1);
    failure = true;
    await feed.refresh();
    assert.equal(feed.current?.updatedAt, 7);
    assert.match(
        feed.current?.warnings.join('') ?? '',
        /前回の表示を保持.*JSON破損/,
    );
    failure = false;
    await feed.refresh();
    assert.deepEqual(feed.current?.warnings, []);
    feed.dispose();
});
test('破損した初回読取りは空一覧成功にせず失敗を通知する', async () => {
    const messages: BoardUpdate[] = [];
    const feed = new BoardFeed(async () => {
        throw Error('不正な台帳');
    });
    feed.subscribe((m) => messages.push(m));
    await feed.refresh();
    assert.equal(feed.current, undefined);
    assert.equal(messages[0].type, 'status');
    if (messages[0].type === 'status') assert.equal(messages[0].failed, true);
    feed.dispose();
});
test('Webview入力は固定操作とID・版だけを採用し任意コマンドやURLを受けない', () => {
    for (const value of [
        null,
        'ran',
        {
            type: 'operation',
            operation: 'delete',
            id: 'U1',
            revision: 'a'.repeat(64),
        },
        {
            type: 'operation',
            operation: 'ran',
            id: 'U1;echo',
            revision: 'a'.repeat(64),
        },
        { type: 'operation', operation: 'ran', id: 'U1', revision: 'old' },
    ])
        assert.equal(parseBoardMessage(value), undefined);
    assert.deepEqual(
        parseBoardMessage({
            type: 'open',
            linkId: 'U1:doc',
            uri: 'command:evil',
        }),
        { type: 'open', linkId: 'U1:doc' },
    );
    assert.deepEqual(
        parseBoardMessage({
            type: 'operation',
            operation: 'ran',
            id: 'U1',
            revision: 'a'.repeat(64),
            command: 'echo evil',
        }),
        {
            type: 'operation',
            operation: 'ran',
            id: 'U1',
            revision: 'a'.repeat(64),
        },
    );
});
test('リンクはworkspace内のfileまたは正規の外部・Claudeセッションだけを開く', () => {
    assert.deepEqual(
        resolveBoardTarget('/workspace', { kind: 'task', id: 'T1' }),
        { file: '/workspace/.agents/ローカルタスク/監督/タスク/T1.md' },
    );
    for (const path of ['../secret', '/outside/file', 'x\0y'])
        assert.throws(() =>
            resolveBoardTarget('/workspace', { kind: 'file', path }),
        );
    for (const uri of [
        'command:evil',
        'javascript:alert(1)',
        'file:///etc/passwd',
        'vscode://other/open?session=abc',
    ])
        assert.throws(() =>
            resolveBoardTarget('/workspace', { kind: 'external', uri }),
        );
    assert.deepEqual(
        resolveBoardTarget('/workspace', {
            kind: 'external',
            uri: 'https://example.com/task',
        }),
        { external: 'https://example.com/task' },
    );
});
test('現在の一覧にあるリンク・許可された行操作だけを受ける', () => {
    const board = snapshot();
    board.sections.push({
        id: 'execution',
        title: '実行',
        defaultOpen: true,
        cards: [
            {
                id: 'U1',
                title: '依頼',
                summary: '内容',
                links: [
                    {
                        id: 'doc',
                        label: '資料',
                        target: { kind: 'file', path: 'docs/a.md' },
                    },
                ],
                fields: [],
                operations: [
                    {
                        operation: 'complete',
                        id: 'U1',
                        revision: 'a'.repeat(64),
                        label: '完了',
                    },
                ],
            },
        ],
    });
    assert.equal(findBoardLink(board, 'not-in-board'), undefined);
    assert.equal(findBoardLink(board, 'doc')?.label, '資料');
    assert.equal(
        hasBoardOperation(board, {
            type: 'operation',
            operation: 'complete',
            id: 'U1',
            revision: 'a'.repeat(64),
        }),
        true,
    );
    assert.equal(
        hasBoardOperation(board, {
            type: 'operation',
            operation: 'ran',
            id: 'U1',
            revision: 'a'.repeat(64),
        }),
        false,
    );
});

function operationFixture() {
    const row: Action = {
        id: 'U1',
        taskId: 'T1',
        text: '依頼',
        kind: 'execution',
        command: 'echo 済',
        done: false,
    };
    const errors: string[] = [];
    let saved = false,
        picked = false;
    const gateway: ActionGateway = {
        root: '/fixture',
        read: async () => ({ version: 1, actions: [row] }),
        complete: async () => {
            saved = true;
        },
        answerContext: async () => {
            throw Error('未使用');
        },
        answer: async () => {
            throw Error('未使用');
        },
        hasAnswer: async () => false,
    };
    const ui: Interaction = {
        pick: async () => {
            picked = true;
            return row;
        },
        choice: async () => undefined,
        recover: async () => undefined,
        input: async () => undefined,
        answerInput: async () => undefined,
        confirm: async () => true,
        info: () => {},
        error: (m) => errors.push(m),
    };
    let pending: PendingAnswer | undefined;
    const drafts = {
        get: () => pending,
        set: async (_key: string, value: PendingAnswer | undefined) => {
            pending = value;
        },
    };
    return {
        row,
        gateway,
        ui,
        errors,
        drafts,
        setDraft: (v: PendingAnswer) => {
            pending = v;
        },
        saved: () => saved,
        picked: () => picked,
    };
}
test('一覧から指定した行はパレットで選び直さず確認・保存へ進む', async () => {
    const f = operationFixture();
    await record('complete', f.gateway, f.ui, f.drafts, {
        id: 'U1',
        revision: revision(f.row),
    });
    assert.equal(f.saved(), true);
    assert.equal(f.picked(), false);
    assert.deepEqual(f.errors, []);
});
test('一覧表示後に依頼が変われば別行の操作へ付け替えず拒否する', async () => {
    const f = operationFixture(),
        old = revision(f.row);
    f.row.text = '変更後';
    await record('complete', f.gateway, f.ui, f.drafts, {
        id: 'U1',
        revision: old,
    });
    assert.equal(f.saved(), false);
    assert.equal(f.picked(), false);
    assert.match(f.errors[0], /一覧の依頼が更新/);
});
test('別依頼の未保存回答を一覧のクリック先へ取り違えない', async () => {
    const f = operationFixture();
    f.row.kind = 'decision';
    f.setDraft({
        id: 'U2',
        answer: '前の原文',
        respondent: '利用者',
        commandId: 'old-id',
        requestVersion: 'a'.repeat(64),
        confirmedResult: false,
    });
    await record('answer', f.gateway, f.ui, f.drafts, {
        id: 'U1',
        revision: revision(f.row),
    });
    assert.match(f.errors[0], /U2 の未保存回答/);
    assert.equal(f.drafts.get()?.answer, '前の原文');
});
