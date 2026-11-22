import assert from 'node:assert/strict';
import { test } from 'node:test';
import { revision } from '../src/boardClient.ts';
import { projectBoard } from '../src/boardModel.ts';
import type {
    BoardCard,
    BoardLink,
    BoardSnapshot,
} from '../src/dashboardTypes.ts';
import {
    type UserActionRow,
    UserActionsUnavailable,
    type UserActionsView,
} from '../src/userActionsView.ts';

const task = (id = 'T1', extra = {}) => ({
    id,
    title: `タスク${id}`,
    status: '実装中',
    tickets: [],
    branches: [],
    prs: [],
    sessions: [],
    related: [],
    notes: [],
    createdAt: 1,
    updatedAt: 2,
    ...extra,
});
const request = (id = 'U1', extra = {}) => ({
    id,
    taskId: 'T1',
    text: `依頼${id}`,
    command: '確認する',
    done: false,
    createdAt: 1,
    ...extra,
});
const noOperations = {
    execute: false,
    answer: false,
    complete: false,
    confirmResult: false,
};
const available = {
    actionable: true,
    held: false,
    holdReason: null,
    pendingPrerequisites: [],
};
const row = (
    action: UserActionRow['action'],
    view: Pick<UserActionRow, 'kind' | 'lifecycle' | 'operations'> &
        Partial<Pick<UserActionRow, 'availability' | 'task' | 'version'>>,
): UserActionRow => ({
    id: action.id,
    version: '行の表示版',
    task: null,
    availability: available,
    action,
    ...view,
});
const ready = (
    rows: UserActionRow[] = [],
    mode: UserActionsView['source']['mode'] = 'legacy',
): Extract<UserActionsView, { status: 'ready' }> => ({
    schemaVersion: 1,
    status: 'ready',
    viewVersion: '一覧の表示版',
    source: { mode, epoch: null, fetchedAt: 1000, error: null },
    rows,
});
const input = (extra = {}) => ({
    registry: { version: 1, tasks: [task()], actions: [] },
    userActions: ready(),
    archive: { tasks: [] },
    state: {},
    events: [],
    updatedAt: 1000,
    source: 'legacy' as const,
    ...extra,
});
const cards = (s: BoardSnapshot, id: string): BoardCard[] => {
    const section = s.sections.find((v) => v.id === id);
    assert.ok(section, id);
    return section.cards;
};
const ids = (s: BoardSnapshot, id: string): string[] =>
    cards(s, id).map((v) => v.id);
const fields = (c: BoardCard): string =>
    c.fields
        .map((v) => `${v.label}: ${v.parts.map((p) => p.text).join('\n')}`)
        .join('\n');
const links = (s: BoardSnapshot): BoardLink[] => [
    ...(s.supervisor ? [s.supervisor] : []),
    ...s.sections.flatMap((v) =>
        v.cards.flatMap((c) => [
            ...c.links,
            ...c.fields.flatMap((f) =>
                f.parts.flatMap((p) => (p.link ? [p.link] : [])),
            ),
        ]),
    ),
];

test('共通ビューの順序・区分・操作候補を使い、タスクの依頼件数へ反映する', () => {
    const rows = [
        row(request('U3'), {
            kind: 'execution',
            lifecycle: 'unexecuted',
            operations: { ...noOperations, execute: true, complete: true },
        }),
        row(request('U2', { needsOk: true }), {
            kind: 'execution',
            lifecycle: 'unexecuted',
            operations: { ...noOperations, execute: true },
        }),
        row(request('U1', { kind: 'decision' }), {
            kind: 'decision',
            lifecycle: 'decision',
            operations: { ...noOperations, answer: true, complete: true },
        }),
        row(request('U4', { holdReason: '解除条件' }), {
            kind: 'execution',
            lifecycle: 'unexecuted',
            availability: {
                ...available,
                actionable: false,
                held: true,
                holdReason: '解除条件',
            },
            operations: noOperations,
        }),
        row(request('U5', { after: ['U4', 'U6'] }), {
            kind: 'execution',
            lifecycle: 'unexecuted',
            availability: {
                actionable: false,
                held: true,
                holdReason: '前提 U4 の完了待ち',
                pendingPrerequisites: ['U4'],
            },
            operations: noOperations,
        }),
        row(request('U6', { done: true }), {
            kind: 'execution',
            lifecycle: 'completed',
            availability: { ...available, actionable: false },
            operations: noOperations,
        }),
        row(request('U7', { withdrawal: { at: 2, reason: '取り下げ' } }), {
            kind: 'execution',
            lifecycle: 'withdrawn',
            availability: { ...available, actionable: false },
            operations: noOperations,
        }),
    ];
    const snapshot = projectBoard(
        input({
            registry: {
                version: 1,
                tasks: [task('T1', { status: '保留' })],
                actions: rows.map(({ action }) => action).reverse(),
            },
            userActions: ready(rows),
        }),
    );
    assert.deepEqual(ids(snapshot, 'execution'), ['U3', 'U2']);
    assert.deepEqual(ids(snapshot, 'decision'), ['U1']);
    assert.deepEqual(ids(snapshot, 'held'), ['U4', 'U5']);
    assert.equal(cards(snapshot, 'execution')[0].badge, '実行 · 優先度 未指定');
    const [execution, needsOk] = cards(snapshot, 'execution');
    assert.deepEqual(
        execution.operations.map(({ operation, label }) => [operation, label]),
        [
            ['complete', '完了'],
            ['ran', 'キック済み'],
        ],
    );
    assert.deepEqual(
        needsOk.operations.map((o) => o.operation),
        ['ran'],
    );
    assert.deepEqual(
        cards(snapshot, 'decision')[0].operations.map(
            ({ operation, label }) => [operation, label],
        ),
        [
            ['complete', '推奨で進める'],
            ['answer', '回答'],
        ],
    );
    assert.match(
        fields(cards(snapshot, 'held')[1]),
        /保留理由・再開条件: 前提 U4 の完了待ち/,
    );
    assert.match(fields(cards(snapshot, 'held')[1]), /前提: U4・U6/);
    assert.ok(cards(snapshot, 'held').every((v) => v.operations.length === 0));
    assert.ok(
        snapshot.sections.every(({ cards }) =>
            cards.every(({ id }) => id !== 'U6' && id !== 'U7'),
        ),
    );
    const taskStatus = fields(cards(snapshot, 'held-tasks')[0]);
    assert.match(taskStatus, /実行待ち 2 \/ 判断待ち 1/);
    assert.match(taskStatus, /保留中の依頼 2/);
});

test('一般の実行済みと結果確認待ちを分け、実行後も保留理由と前提を表示する', () => {
    const rows = [
        row(request('U1', { ranAt: 1 }), {
            kind: 'execution',
            lifecycle: 'executed',
            operations: { ...noOperations, complete: true },
        }),
        row(request('U2', { ranAt: 1, holdReason: '保留' }), {
            kind: 'execution',
            lifecycle: 'executed',
            availability: {
                ...available,
                actionable: false,
                holdReason: '保留',
            },
            operations: noOperations,
        }),
        row(request('U3', { ranAt: 1, needsOk: true }), {
            kind: 'execution',
            lifecycle: 'awaiting-result',
            operations: { ...noOperations, confirmResult: true },
        }),
        row(request('U4', { ranAt: 1, needsOk: true, after: ['U2'] }), {
            kind: 'execution',
            lifecycle: 'awaiting-result',
            availability: {
                ...available,
                actionable: false,
                holdReason: '前提 U2 の完了待ち',
                pendingPrerequisites: ['U2'],
            },
            operations: noOperations,
        }),
    ];
    const snapshot = projectBoard(
        input({
            registry: {
                version: 1,
                tasks: [task()],
                actions: rows.map(({ action }) => action),
            },
            userActions: ready(rows),
        }),
    );
    assert.deepEqual(ids(snapshot, 'executed'), ['U1', 'U2']);
    assert.deepEqual(ids(snapshot, 'awaiting'), ['U3', 'U4']);
    assert.deepEqual(ids(snapshot, 'held'), []);
    const [executed, held] = cards(snapshot, 'executed');
    assert.match(fields(executed), /実行済み: .*・完了待ち/);
    assert.equal(executed.operations[0].label, '完了');
    assert.match(fields(held), /保留理由・再開条件: 保留/);
    assert.deepEqual(held.operations, []);
    const [awaiting, pending] = cards(snapshot, 'awaiting');
    assert.match(fields(awaiting), /実行済み: .*・結果の確認待ち/);
    assert.deepEqual(
        awaiting.operations.map(({ operation, label }) => [operation, label]),
        [['complete', '結果確認 OK']],
    );
    assert.match(fields(pending), /保留理由・再開条件: 前提 U2 の完了待ち/);
    assert.match(fields(pending), /前提: U2/);
    assert.deepEqual(pending.operations, []);
    const taskStatus = fields(cards(snapshot, 'tasks')[0]);
    assert.match(taskStatus, /実行済み（完了待ち） 2/);
    assert.match(taskStatus, /結果の確認待ち 2/);
});

test('空の正常な一覧と共通ビューの取得失敗を区別する', () => {
    const snapshot = projectBoard(input());
    assert.deepEqual(ids(snapshot, 'execution'), []);
    const view = ready();
    assert.deepEqual(snapshot.userActions, {
        status: view.status,
        viewVersion: view.viewVersion,
        source: view.source,
    });
    const unavailable: UserActionsView = {
        schemaVersion: 1,
        viewVersion: '取得失敗の表示版',
        status: 'unavailable',
        source: {
            mode: 'legacy',
            epoch: null,
            fetchedAt: 1000,
            error: { code: 'read-failed', message: '取得できませんでした' },
        },
        rows: null,
    };
    assert.throws(
        () => projectBoard(input({ userActions: unavailable })),
        (error) => {
            assert.ok(error instanceof UserActionsUnavailable);
            assert.deepEqual(error.view, unavailable);
            return true;
        },
    );
});

test('表示の版や区分が変わっても依頼とリンクのIDを維持する', () => {
    const action = request('U1', { needsOk: true });
    const open = row(action, {
        kind: 'execution',
        lifecycle: 'unexecuted',
        operations: { ...noOperations, execute: true },
    });
    const changed = { ...open, version: 'タスク補足の更新を反映した表示版' };
    const awaiting = row(
        { ...action, ranAt: 3 },
        {
            kind: 'execution',
            lifecycle: 'awaiting-result',
            operations: { ...noOperations, confirmResult: true },
            version: '結果の確認待ちの表示版',
        },
    );
    const snapshot = (item: UserActionRow, viewVersion: string) =>
        projectBoard(
            input({
                registry: {
                    version: 1,
                    tasks: [task()],
                    actions: [item.action],
                },
                userActions: { ...ready([item]), viewVersion },
            }),
        );
    const before = cards(snapshot(open, '一覧の表示版1'), 'execution')[0];
    const after = cards(snapshot(changed, '一覧の表示版2'), 'execution')[0];
    const moved = cards(snapshot(awaiting, '一覧の表示版3'), 'awaiting')[0];
    assert.equal(before.id, after.id);
    assert.equal(before.id, moved.id);
    assert.equal(before.operations[0].revision, after.operations[0].revision);
    assert.notEqual(
        before.operations[0].revision,
        moved.operations[0].revision,
    );
    const taskLink = (card: BoardCard) =>
        card.fields.find((field) => field.label === 'タスク')?.parts[0].link
            ?.id;
    assert.ok(taskLink(before));
    assert.equal(taskLink(before), taskLink(moved));
});

test('依頼の全文・コマンド・資料・推奨回答と原票の追加属性を保持したrevisionを運ぶ', () => {
    const raw = {
        custom: { z: 1, a: 2 },
        ...request('U1', {
            summary: '短い見出し',
            kind: 'decision',
            needsOk: true,
            priority: 3,
            command: '一行目\n二行目',
            text: '<script>外部の原文</script>\n全文',
            doc: `${'.agents/ローカルタスク'}/判断.md`,
        }),
    };
    const before = JSON.stringify(raw);
    const selected = {
        ...raw,
        runtime: { epoch: 'test', taskId: 'T1', version: 7 },
    };
    const view = ready(
        [
            row(raw, {
                kind: 'decision',
                lifecycle: 'decision',
                operations: { ...noOperations, answer: true },
            }),
        ],
        'authoritative',
    );
    view.source.epoch = 'test';
    const snapshot = projectBoard(
        input({
            registry: { version: 1, tasks: [task()], actions: [selected] },
            source: 'authoritative',
            userActions: view,
        }),
    );
    const card = cards(snapshot, 'decision')[0];
    assert.equal(card.title, '短い見出し');
    assert.equal(card.badge, '判断 · 優先度 3');
    assert.match(fields(card), /<script>外部の原文<\/script>\n全文/);
    assert.match(fields(card), /推奨回答: 推奨で進める/);
    assert.equal(
        card.fields.find((f) => f.label === 'コマンド・手順')?.pre,
        true,
    );
    assert.match(fields(card), /表示内容の版: 行の表示版/);
    assert.equal(card.operations[0].revision, revision(selected));
    assert.equal(JSON.stringify(raw), before);
    assert.ok(
        links(snapshot).some(
            (l) =>
                l.target.kind === 'file' &&
                l.target.path === '.agents/ローカルタスク/判断.md',
        ),
    );
});

test('タスクは正本のstatus順・更新降順、完了は完了日時降順、アーカイブは移動日時降順', () => {
    const action = request('U1', { taskId: 'T8' });
    const snapshot = projectBoard(
        input({
            registry: {
                version: 1,
                tasks: [
                    task('T1', { status: '調査中' }),
                    task('T2', { status: 'ユーザー待ち' }),
                    task('T3', { updatedAt: 10 }),
                    task('T4'),
                    task('T5', { status: '保留' }),
                    task('T6', { status: '完了', completedAt: 10 }),
                    task('T7', { status: '完了', completedAt: 20 }),
                ],
                actions: [action],
            },
            userActions: ready([
                row(action, {
                    kind: 'execution',
                    lifecycle: 'unexecuted',
                    operations: {
                        ...noOperations,
                        execute: true,
                        complete: true,
                    },
                }),
            ]),
            archive: {
                tasks: [
                    task('T8', { status: '完了', archivedAt: 10 }),
                    task('T9', { status: '完了', archivedAt: 20 }),
                ],
            },
        }),
    );
    assert.deepEqual(ids(snapshot, 'tasks'), ['T2', 'T3', 'T4', 'T1']);
    assert.deepEqual(ids(snapshot, 'held-tasks'), ['T5']);
    assert.deepEqual(ids(snapshot, 'completed'), ['T7', 'T6']);
    assert.deepEqual(ids(snapshot, 'archive'), ['T9', 'T8']);
    assert.ok(
        links(snapshot).some(
            (l) => l.target.kind === 'task' && l.target.id === 'T8',
        ),
    );
    assert.equal(
        snapshot.counts.find((c) => c.section === 'archive')?.value,
        2,
    );
});

test('全事実・現行と過去の全セッション・関連とメモを型付き表示項目へ渡す', () => {
    const current = {
        cli: 'claude',
        id: 'active',
        state: '入力待ち',
        model: 'claude-opus-5-5',
        title: '現在の題',
        name: '担当',
        cwd: '.codex/worktrees/branch/sub',
        branch: 'feature/試験',
        firstPrompt: '最初の依頼',
        lastPrompt: '直近の依頼',
        lastReport: '報告の全文',
        updatedAt: 60,
    };
    const past = {
        ...current,
        cli: 'codex',
        id: 'past',
        model: 'gpt-6.2',
        title: '過去の題',
        matches: ['題', '依頼文'],
    };
    const facts = {
        at: 100,
        sessions: {
            'claude:active': current,
            'codex:supervisor': {
                ...current,
                cli: 'codex',
                id: 'supervisor',
                title: '監督の題',
            },
        },
        branches: {
            'feature/試験': {
                name: 'feature/試験',
                head: 'a'.repeat(40),
                subject: 'コミットの題',
                committedAt: 10,
                pushed: true,
                ahead: 2,
                mergedDevelop: false,
            },
        },
        prs: {
            1: {
                number: 1,
                title: 'PRの題',
                state: 'OPEN',
                isDraft: false,
                url: 'https://github.com/actual/repo/pull/1',
                headRef: 'feature/試験',
                headOid: 'b'.repeat(40),
                labels: ['マージ保留', 'マージレビュー：確認待ち'],
                checks: 'SUCCESS',
                mergeable: 'CONFLICTING',
                commentCount: 3,
                reviewCount: 4,
                lastComment: {
                    at: 20,
                    author: 'PR著者',
                    text: 'PR最新コメント',
                },
            },
        },
        jira: {
            'DEVMIN-1': {
                key: 'DEVMIN-1',
                summary: 'Jiraの題',
                status: '作業中（詳細）',
                url: 'https://jira.example/browse/DEVMIN-1',
                commentCount: 2,
                lastComment: {
                    at: 30,
                    author: 'Jira著者',
                    text: 'Jira最新コメント',
                },
            },
        },
        prsByBranch: { 'feature/試験': [1] },
        worktrees: [
            { rel: '.codex/worktrees/branch', branch: 'feature/別', head: 'c' },
        ],
        dirty: { '.codex/worktrees/branch': 3 },
        past: {
            T1: [past, current, { ...current, cli: 'codex', id: 'supervisor' }],
        },
        pastTotal: { T1: 5 },
        pastFetchedAt: 80,
        warnings: ['GitHubの前回の値を表示'],
    };
    const snapshot = projectBoard(
        input({
            registry: {
                version: 1,
                supervisor: { cli: 'codex', id: 'supervisor' },
                tasks: [
                    task('T1', {
                        tickets: ['DEVMIN-1'],
                        branches: ['feature/試験'],
                        prs: [1],
                        sessions: [
                            { cli: 'claude', id: 'active', role: '実装' },
                        ],
                        related: ['T2', 'DEVMIN-2', 'その他'],
                        notes: ['調査/メモ.md'],
                        imported: true,
                    }),
                ],
                actions: [],
            },
            archive: { tasks: [task('T2', { status: '完了', archivedAt: 2 })] },
            state: { facts },
            events: [
                {
                    at: 70,
                    taskId: 'T1',
                    kind: 'note',
                    text: '最新の進捗報告',
                    by: 'codex:test',
                    report: true,
                },
            ],
        }),
    );
    const content = fields(cards(snapshot, 'tasks')[0]);
    for (const expected of [
        '要確認',
        '最新の進捗報告',
        'PR #1 マージレビュー確認待ち（ベースと衝突）',
        'Jiraの題',
        '作業中（詳細）',
        'Jira最新コメント',
        'a'.repeat(40),
        '未 push 2',
        'コミットの題',
        '未コミット 3',
        'PRの題',
        'マージ保留',
        'b'.repeat(40),
        '衝突の解消後',
        'PR最新コメント',
        'Claude Code · Opus 5.5 (実装)',
        '入力待ち',
        '現在の題',
        '最初の依頼',
        '直近の依頼',
        '報告の全文',
        '過去のセッション: 3 件',
        'Codex · gpt-6.2',
        '過去の題',
        'codex resume past',
        '一致: 題・依頼文',
        'T2 タスクT2',
        '調査/メモ.md',
    ])
        assert.ok(content.includes(expected), expected);
    assert.equal(
        cards(snapshot, 'tasks')[0].fields.filter((f) =>
            f.label.startsWith('過去のAI'),
        ).length,
        1,
    );
    assert.ok(
        links(snapshot).some(
            (l) =>
                l.target.kind === 'external' &&
                l.target.uri === facts.prs[1].url,
        ),
    );
    assert.ok(
        links(snapshot).some(
            (l) =>
                l.target.kind === 'external' &&
                l.target.uri === facts.jira['DEVMIN-1'].url,
        ),
    );
    assert.ok(
        links(snapshot).some(
            (l) =>
                l.target.kind === 'file' &&
                l.target.path === '.agents/ローカルタスク/調査/メモ.md',
        ),
    );
    assert.equal(
        new Set(links(snapshot).map((l) => l.id)).size,
        links(snapshot).length,
    );
    assert.match(snapshot.supervisor?.label ?? '', /担当/);
});

test('待ちの理由は新しい報告でも保持し、それ以外の補足は新しい報告で置き換える', () => {
    const tasks = [
        task('T1', {
            status: '保留',
            statusNote: '再開条件\n詳細条件',
            statusNoteAt: 1,
        }),
        task('T2', { statusNote: '古い補足', statusNoteAt: 1 }),
        task('T3', { statusNote: '新しい補足', statusNoteAt: 20 }),
    ];
    const events = tasks.map((t) => ({
        at: 10,
        taskId: t.id,
        kind: 'note',
        text: '**新しい報告**\n本文',
        by: 'codex:test',
        report: true,
    }));
    const snapshot = projectBoard(
        input({ registry: { version: 1, tasks, actions: [] }, events }),
    );
    const heldCard = cards(snapshot, 'held-tasks')[0];
    assert.equal(heldCard.fields[0].parts[1].text, '再開条件\n詳細条件');
    assert.equal(heldCard.title, 'タスクT1');
    assert.equal(heldCard.summary, '再開条件');
    const live = cards(snapshot, 'tasks');
    assert.match(
        live.find((t) => t.id === 'T2')?.fields[0].parts[1].text ?? '',
        /新しい報告/,
    );
    assert.equal(
        live.find((t) => t.id === 'T3')?.fields[0].parts[1].text,
        '新しい補足',
    );
});

test('通知は未処理のみで本文・宛先・出典を保持し、警告・更新時刻・直近20イベントを運ぶ', () => {
    const hit = {
        key: 'one',
        where: 'PR #1',
        kind: 'コメント',
        author: '担当者',
        at: 1,
        url: 'https://example.com/one',
        reason: 'メンション',
        agent: false,
        snippet: '<b>通知の原文</b>',
        notifiedAt: 2,
    };
    const events = Array.from({ length: 25 }, (_, n) => ({
        at: n,
        taskId: 'T1',
        kind: 'note',
        text: `イベント${n}`,
        by: 'ユーザー',
    }));
    events.push({
        at: 30,
        taskId: 'T999',
        kind: 'note',
        text: '削除済みのイベント',
        by: 'ユーザー',
    });
    const snapshot = projectBoard(
        input({
            source: 'authoritative',
            userActions: ready([], 'authoritative'),
            readWarnings: ['archive読取り警告'],
            state: {
                facts: { warnings: ['GitHubの取得失敗'] },
                userMentions: {
                    attemptedAt: 10,
                    byUser: {
                        'github:alice': {
                            items: {
                                one: hit,
                                two: { ...hit, key: 'two', ackedAt: 3 },
                            },
                        },
                        'jira:account': {
                            items: {
                                three: {
                                    ...hit,
                                    key: 'three',
                                    where: 'DEVMIN-1',
                                },
                            },
                        },
                    },
                },
            },
            events,
        }),
    );
    assert.equal(snapshot.source, 'authoritative');
    assert.equal(snapshot.updatedAt, 1000);
    assert.deepEqual(snapshot.warnings, [
        'archive読取り警告',
        'GitHubの取得失敗',
    ]);
    assert.equal(cards(snapshot, 'notices').length, 2);
    assert.match(fields(cards(snapshot, 'notices')[0]), /github:alice/);
    assert.match(fields(cards(snapshot, 'notices')[0]), /<b>通知の原文<\/b>/);
    assert.equal(cards(snapshot, 'events').length, 20);
    assert.equal(cards(snapshot, 'events')[0].summary, 'イベント24');
    assert.equal(cards(snapshot, 'events').at(-1)?.summary, 'イベント5');
    assert.deepEqual(
        projectBoard(
            input({
                events: [null],
                state: { facts: { sessions: { invalid: {} } } },
            }),
        ).warnings,
        [
            '事実キャッシュ sessions/invalid の形式が不正です',
            'イベントの形式が不正なため表示できない行があります',
        ],
    );
});

test('境界で台帳の形式・重複IDを拒否し、不正なリンクを有効なリンクとして渡さない', () => {
    assert.throws(
        () =>
            projectBoard(
                input({ registry: { version: 2, tasks: [], actions: [] } }),
            ),
        /未対応/,
    );
    assert.throws(
        () =>
            projectBoard(
                input({
                    registry: {
                        version: 1,
                        tasks: [task(), task()],
                        actions: [],
                    },
                }),
            ),
        /重複/,
    );
    assert.throws(
        () =>
            projectBoard(
                input({
                    registry: {
                        version: 1,
                        tasks: [task()],
                        actions: [request('U1', { after: [1] })],
                    },
                }),
            ),
        /文字列/,
    );
    const actions = [
        request('U1', { doc: '../../../etc/passwd' }),
        request('U2', { doc: 'javascript:alert(1)' }),
    ];
    const snapshot = projectBoard(
        input({
            registry: {
                version: 1,
                tasks: [task('T1', { notes: ['../../../etc/passwd'] })],
                actions,
            },
            userActions: ready(
                actions.map((action) =>
                    row(action, {
                        kind: 'execution',
                        lifecycle: 'unexecuted',
                        operations: {
                            ...noOperations,
                            execute: true,
                            complete: true,
                        },
                    }),
                ),
            ),
        }),
    );
    assert.ok(
        links(snapshot).every(
            (l) => l.target.kind !== 'file' || !l.target.path.startsWith('../'),
        ),
    );
    assert.ok(
        links(snapshot).every(
            (l) =>
                l.target.kind !== 'external' ||
                !l.target.uri.startsWith('javascript:'),
        ),
    );
});

test('事実がないJiraとPRは既定URLを使い、既存イベントのリンクIDは追記後も変えない', () => {
    const registry = {
        version: 1,
        tasks: [task('T1', { tickets: ['DEVMIN-1', 'DEVMIN-1'], prs: [1] })],
        actions: [],
    };
    const first = {
        at: 1,
        taskId: 'T1',
        kind: 'note',
        text: '同じ時刻にも複数記録できる',
        by: 'ユーザー',
    };
    const before = projectBoard(
        input({
            registry,
            repoUrl: 'https://github.com/example/repo/',
            events: [first, first],
        }),
    );
    const after = projectBoard(
        input({
            registry,
            repoUrl: 'https://github.com/example/repo/',
            events: [first, first, { ...first, at: 2, text: '次の記録' }],
        }),
    );
    assert.ok(
        links(before).some(
            (l) =>
                l.target.kind === 'external' &&
                l.target.uri === 'https://github.com/example/repo/pull/1',
        ),
    );
    assert.ok(
        links(before).some(
            (l) =>
                l.target.kind === 'external' &&
                l.target.uri ===
                    'https://my-atlassian-site-769979.atlassian.net/browse/DEVMIN-1',
        ),
    );
    assert.deepEqual(
        cards(after, 'events')
            .slice(1)
            .map((c) => c.links[0].id),
        cards(before, 'events').map((c) => c.links[0].id),
    );
    assert.equal(
        new Set(links(before).map((l) => l.id)).size,
        links(before).length,
    );
    assert.equal(new Set(cards(before, 'events').map((c) => c.id)).size, 2);
});

test('多数タスクのイベントが交互に並んでも補足と最新記録はタスクごとの原票順を守る', () => {
    const tasks = Array.from({ length: 80 }, (_, index) => ({
        ...task(`T${index + 1}`),
        statusNote: `手書き補足${index + 1}`,
    }));
    const events = tasks.flatMap((t) => [
        {
            at: 2000,
            taskId: t.id,
            kind: 'status',
            text: t.statusNote,
            by: 'ユーザー',
        },
        {
            at: 10000,
            taskId: t.id,
            kind: 'note',
            text: `${t.id} 時刻が大きい以前の報告`,
            by: 'codex:test',
            report: true,
        },
        {
            at: 100,
            taskId: t.id,
            kind: 'status',
            text: t.statusNote,
            by: 'ユーザー',
        },
    ]);
    for (let round = 0; round < 60; round++) {
        for (const t of tasks)
            events.push({
                at: 101 + round,
                taskId: t.id,
                kind: 'note',
                text: `${t.id} 原票順の報告${round}`,
                by: 'codex:test',
                report: true,
            });
    }
    events.push({
        at: 99999,
        taskId: 'T999',
        kind: 'note',
        text: '別タスクの記録',
        by: 'codex:test',
        report: true,
    });
    const raw = input({ registry: { version: 1, tasks, actions: [] }, events });
    const before = JSON.stringify(raw);
    for (const e of events) Object.freeze(e);
    Object.freeze(events);
    const snapshot = projectBoard(raw);
    for (const card of cards(snapshot, 'tasks')) {
        const status = card.fields.find((f) => f.label === 'ステータス');
        assert.ok(status);
        assert.match(
            status.parts[1].text,
            new RegExp(`${card.id} 原票順の報告59$`),
        );
        const latest = card.fields.find((f) => f.label === '最新イベント');
        assert.ok(latest);
        assert.match(
            latest.parts[0].text,
            new RegExp(`${card.id} 原票順の報告59 \\(codex:test\\)$`),
        );
    }
    assert.deepEqual(
        cards(snapshot, 'events').map((c) => c.summary),
        tasks
            .slice(-20)
            .reverse()
            .map((t) => `${t.id} 原票順の報告59`),
    );
    assert.equal(JSON.stringify(raw), before);
});

test('コマンドの原文コピーは保留中も使え、空コマンドには付けない', () => {
    const raw = "  printf '%s\\n' '$HOME'\nnode ./cli.ts  ";
    const source = request('U1', { command: raw, holdReason: '前提確認中' });
    const actions = [
        source,
        request('U2', { command: '' }),
        request('U3', { command: ' \n ' }),
    ];
    const board = projectBoard(
        input({
            userActions: ready(
                actions.map((action) =>
                    row(action, {
                        kind: 'execution',
                        lifecycle: 'unexecuted',
                        operations: noOperations,
                        availability:
                            action.id === 'U1'
                                ? {
                                      ...available,
                                      actionable: false,
                                      held: true,
                                      holdReason: '前提確認中',
                                  }
                                : { ...available, actionable: false },
                    }),
                ),
            ),
            registry: {
                version: 1,
                tasks: [task()],
                actions,
            },
        }),
    );
    assert.deepEqual(cards(board, 'held')[0].command, {
        id: 'U1',
        revision: revision(source),
        text: raw,
    });
    assert.equal(
        cards(board, 'execution').find((c) => c.id === 'U2')?.command,
        undefined,
    );
    assert.equal(
        cards(board, 'execution').find((c) => c.id === 'U3')?.command,
        undefined,
    );
});
