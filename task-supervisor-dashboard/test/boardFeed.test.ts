import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BoardFeed } from '../src/boardFeed.ts';
import type { BoardSnapshot, BoardUpdate } from '../src/dashboardTypes.ts';
import { UserActionsUnavailable } from '../src/userActionsView.ts';

const readyVersion = 'a'.repeat(64);
const unavailableVersion = 'b'.repeat(64);
const lastFetchedAt = 1795096800000;
const emptySnapshot: BoardSnapshot = {
    schemaVersion: 1,
    source: 'shadow',
    updatedAt: lastFetchedAt + 100,
    counts: [],
    warnings: [],
    sections: [],
    userActions: {
        status: 'ready',
        viewVersion: readyVersion,
        source: {
            mode: 'shadow',
            epoch: 'shadow-epoch',
            fetchedAt: lastFetchedAt,
            error: null,
        },
    },
};
const unavailable = new UserActionsUnavailable({
    schemaVersion: 1,
    status: 'unavailable',
    viewVersion: unavailableVersion,
    source: {
        mode: 'authoritative',
        epoch: 'authoritative-epoch',
        fetchedAt: lastFetchedAt + 200,
        error: { code: 'runtime-stopped', message: '常駐部が停止しました' },
    },
    rows: null,
});

test('初回失敗は後から購読したビューにも通知し、正常に取得できた空の一覧はスナップショットとして通知する', async (t) => {
    let failed = true;
    const feed = new BoardFeed(async () => {
        if (failed) throw unavailable;
        return emptySnapshot;
    });
    t.after(() => feed.dispose());
    const messages: BoardUpdate[] = [];
    feed.subscribe((message) => messages.push(message));
    await feed.refresh();
    assert.equal(feed.current, undefined);
    assert.deepEqual(messages, [
        {
            type: 'status',
            failed: true,
            state: 'error',
            message: '一覧の読取りに失敗しました（常駐部が停止しました）',
        },
    ]);
    const lateMessages: BoardUpdate[] = [];
    feed.subscribe((message) => lateMessages.push(message));
    assert.deepEqual(lateMessages, messages);

    failed = false;
    await feed.refresh();
    assert.equal(feed.current, emptySnapshot);
    assert.deepEqual(lateMessages[1], {
        type: 'snapshot',
        snapshot: emptySnapshot,
    });
});

test('共通ビューと一般の読取り失敗で前回正常の表示・更新時刻・取得時点を保ち復旧させる', async (t) => {
    const initial: BoardSnapshot = {
        ...emptySnapshot,
        warnings: ['補助資料がありません'],
        sections: [
            {
                id: 'execution',
                title: '実行依頼',
                defaultOpen: true,
                cards: [
                    {
                        id: 'U1',
                        title: '依頼',
                        summary: '処理後に結果を確認する',
                        fields: [],
                        links: [],
                        operations: [
                            {
                                operation: 'ran',
                                id: 'U1',
                                revision: 'task-revision',
                                label: 'キック済み',
                            },
                        ],
                    },
                ],
            },
        ],
    };
    let read = () => initial;
    const feed = new BoardFeed(async () => read());
    t.after(() => feed.dispose());
    const messages: BoardUpdate[] = [];
    feed.subscribe((message) => messages.push(message));
    await feed.refresh();
    read = () => {
        throw unavailable;
    };
    await feed.refresh();
    const lastSuccessful = {
        viewVersion: readyVersion,
        fetchedAt: lastFetchedAt,
    };
    assert.deepEqual(feed.current?.userActions, {
        status: 'unavailable',
        viewVersion: unavailableVersion,
        source: unavailable.view.source,
        lastSuccessful,
    });
    assert.equal(feed.current?.sections, initial.sections);
    assert.equal(feed.current?.updatedAt, initial.updatedAt);
    assert.match(
        feed.current?.warnings[1] ?? '',
        /前回の表示を保持.*常駐部が停止/,
    );
    assert.deepEqual(messages[1], { type: 'snapshot', snapshot: feed.current });
    await feed.refresh();
    assert.equal(messages.length, 2);

    read = () => {
        throw new Error('JSON破損');
    };
    await feed.refresh();
    assert.deepEqual(feed.current?.userActions, {
        status: 'unavailable',
        viewVersion: null,
        source: {
            mode: 'authoritative',
            epoch: 'authoritative-epoch',
            fetchedAt: null,
            error: { code: 'read-failed', message: 'JSON破損' },
        },
        lastSuccessful,
    });
    assert.equal(feed.current?.sections, initial.sections);
    assert.equal(feed.current?.updatedAt, initial.updatedAt);
    assert.equal(feed.current?.warnings.length, 2);
    assert.equal(feed.current?.warnings[0], initial.warnings[0]);
    assert.match(feed.current?.warnings[1] ?? '', /前回の表示を保持.*JSON破損/);
    read = () => initial;
    await feed.refresh();
    assert.equal(feed.current, initial);
    assert.deepEqual(messages[3], { type: 'snapshot', snapshot: initial });
});
