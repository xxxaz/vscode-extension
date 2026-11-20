import assert from 'node:assert/strict';
import { test } from 'node:test';
import { candidates, revision } from '../src/boardClient.ts';
import { projectBoard } from '../src/boardModel.ts';
import type {
    BoardCard,
    BoardLink,
    BoardSnapshot,
} from '../src/dashboardTypes.ts';

test('コマンドの原文コピーは保留中も使え、空コマンドには付けない', () => {
    const raw = "  printf '%s\\n' '$HOME'\nnode ./cli.ts  ";
    const source = request('U1', { command: raw, holdReason: '前提確認中' });
    const board = projectBoard(
        input({
            registry: {
                version: 1,
                tasks: [task()],
                actions: [
                    source,
                    request('U2', { command: '' }),
                    request('U3', { command: ' \n ' }),
                ],
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
const input = (extra = {}) => ({
    registry: { version: 1, tasks: [task()], actions: [request()] },
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

test('一般の実行待ちにはキック済みを出さず、結果確認が必要な依頼と完了は残す', () => {
    const snapshot = projectBoard(
        input({
            registry: {
                version: 1,
                tasks: [task('T1')],
                actions: [
                    request('U1855', { needsOk: false }),
                    request('U2'),
                    request('U3', { needsOk: true }),
                ],
            },
        }),
    );
    const rows = cards(snapshot, 'execution');
    for (const id of ['U1855', 'U2']) {
        const row = rows.find((c) => c.id === id)!;
        assert.deepEqual(
            row.operations.map((o) => o.operation),
            ['complete'],
        );
        assert.match(fields(row), /この版では未対応/);
    }
    assert.deepEqual(
        rows.find((c) => c.id === 'U3')!.operations.map((o) => o.operation),
        ['complete', 'ran'],
    );
});

test('依頼は正本の実行・判断・保留・結果待ちへ分類し、優先度と作成時刻で並べる', () => {
    const actions = [
        request('U1', { priority: 2, createdAt: 1 }),
        request('U2', { priority: 1, createdAt: 20 }),
        request('U3', { priority: 1, createdAt: 10 }),
        request('U4', { command: undefined }),
        request('U5', { holdReason: '解除条件' }),
        request('U6', { after: ['U5'] }),
        request('U7', { ranAt: 3, holdReason: '以前の保留' }),
        request('U8', { done: true }),
        request('U9', { withdrawal: { at: 2, reason: '取り下げ' } }),
        request('U10', { after: ['U99'] }),
        request('U11', { after: ['U8'] }),
        request('U12', { after: ['U9'] }),
        request('U13', { after: ['U7'] }),
        request('U14', { kind: 'decision', command: '判断資料の操作例' }),
    ];
    const registry = {
        version: 1,
        tasks: [task('T1', { status: '保留' })],
        actions,
    };
    const snapshot = projectBoard(input({ registry }));
    assert.deepEqual(ids(snapshot, 'execution'), [
        'U3',
        'U2',
        'U1',
        'U10',
        'U11',
    ]);
    assert.deepEqual(ids(snapshot, 'decision'), ['U4', 'U14']);
    assert.deepEqual(ids(snapshot, 'held'), ['U5', 'U6', 'U12', 'U13']);
    assert.deepEqual(ids(snapshot, 'awaiting'), ['U7']);
    assert.equal(
        cards(snapshot, 'execution').find((c) => c.id === 'U10')?.badge,
        '実行 · 優先度 未指定',
    );
    assert.match(fields(cards(snapshot, 'held')[1]), /前提 U5 の完了待ち/);
    assert.ok(cards(snapshot, 'held').every((v) => v.operations.length === 0));
    for (const operation of ['complete', 'ran', 'answer'] as const) {
        const actual = snapshot.sections
            .flatMap((v) =>
                v.cards.flatMap((c) =>
                    c.operations
                        .filter((o) => o.operation === operation)
                        .map((o) => o.id),
                ),
            )
            .sort();
        assert.deepEqual(
            actual,
            candidates(registry, operation)
                .map((v) => v.id)
                .sort(),
        );
    }
    assert.deepEqual(
        cards(snapshot, 'awaiting')[0].operations.map((v) => v.operation),
        [],
    );
});

test('結果待ちの実行依頼には完了だけを出し、保留理由が残る結果待ちは操作を出さない', () => {
    const snapshot = projectBoard(
        input({
            registry: {
                version: 1,
                tasks: [task()],
                actions: [
                    request('U1', { ranAt: 1 }),
                    request('U2', { ranAt: 1, holdReason: '保留' }),
                    request('U3', { ranAt: 1, after: ['U2'] }),
                    request('U4', { command: undefined, taskId: undefined }),
                ],
            },
        }),
    );
    assert.deepEqual(
        cards(snapshot, 'awaiting').map((v) =>
            v.operations.map((o) => o.operation),
        ),
        [['complete'], [], []],
    );
    assert.deepEqual(cards(snapshot, 'decision')[0].operations, []);
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
    const snapshot = projectBoard(
        input({ registry: { version: 1, tasks: [task()], actions: [raw] } }),
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
    assert.equal(card.operations[0].revision, revision(raw));
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
                actions: [request('U1', { taskId: 'T8' })],
            },
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
    const snapshot = projectBoard(
        input({
            registry: {
                version: 1,
                tasks: [task('T1', { notes: ['../../../etc/passwd'] })],
                actions: [
                    request('U1', { doc: '../../../etc/passwd' }),
                    request('U2', { doc: 'javascript:alert(1)' }),
                ],
            },
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
