#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { projectBoard } from '../src/boardModel.ts';
import type { BoardCard, BoardSnapshot } from '../src/dashboardTypes.ts';

type Row = Record<string, unknown>;
class ParityError extends Error {}

function object(value: unknown, label: string): Row {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new ParityError(`${label}のオブジェクト形式が不正です`);
    return value as Row;
}
function rows(value: unknown, label: string): Row[] {
    if (!Array.isArray(value))
        throw new ParityError(`${label}の配列形式が不正です`);
    return value.map((v) => object(v, label));
}
function ids(value: Row[]): unknown[] {
    return value.map((r) => r.id);
}
async function readJson(directory: string, name: string): Promise<unknown> {
    try {
        return JSON.parse(
            await readFile(join(directory, name), 'utf8'),
        ) as unknown;
    } catch {
        throw new ParityError(`${name}を読み取れないか、JSON形式が不正です`);
    }
}
async function readEvents(directory: string): Promise<Row[]> {
    let content: string;
    try {
        content = await readFile(join(directory, 'events.jsonl'), 'utf8');
    } catch {
        throw new ParityError('events.jsonlを読み取れませんでした');
    }
    const result: Row[] = [];
    for (const [index, line] of content.split('\n').entries()) {
        if (!line.trim()) continue;
        try {
            result.push(object(JSON.parse(line) as unknown, 'イベント'));
        } catch {
            throw new ParityError(
                `events.jsonlの${index + 1}行目の形式が不正です`,
            );
        }
    }
    return result;
}
async function loadModule(directory: string, name: string): Promise<Row> {
    try {
        return object(
            await import(pathToFileURL(join(directory, name)).href),
            '正本モジュール',
        );
    } catch {
        throw new ParityError(
            `正本の${name}を読み込めませんでした。指定先と依存関係を確認してください`,
        );
    }
}
function helper<A extends unknown[], R>(
    module: Row,
    name: string,
): (...args: A) => R {
    const fn = module[name];
    if (typeof fn !== 'function')
        throw new ParityError(`正本に公開関数${name}がありません`);
    return fn as (...args: A) => R;
}
function equal(actual: unknown, expected: unknown, label: string): void {
    if (JSON.stringify(actual) !== JSON.stringify(expected))
        throw new ParityError(`${label}が正本と一致しません`);
}

async function main(): Promise<void> {
    const args = process.argv.slice(2);
    if (args.length !== 2)
        throw new ParityError(
            '使い方: node test/board-parity.ts <監督skillディレクトリ> <ワークスペースルート>',
        );
    const [skillDirectory, workspaceRoot] = args.map((arg) => resolve(arg));
    const directory = join(workspaceRoot, '.agents/ローカルタスク/監督');
    const loaded = await Promise.allSettled([
        readJson(directory, 'registry.json'),
        readJson(directory, 'archive.json'),
        readJson(directory, 'state.json'),
        readEvents(directory),
        loadModule(skillDirectory, 'registry.ts'),
        loadModule(skillDirectory, 'render.ts'),
        loadModule(skillDirectory, 'narrative.ts'),
    ]);
    for (const result of loaded)
        if (result.status === 'rejected') throw result.reason;
    const values = loaded.map((result) =>
        result.status === 'fulfilled' ? result.value : undefined,
    );
    const registry = object(values[0], '台帳');
    const archive = object(values[1], 'アーカイブ');
    const state = object(values[2], '状態');
    const events = rows(values[3], 'イベント');
    const registryModule = object(values[4], '正本registry');
    const renderModule = object(values[5], '正本render');
    const narrativeModule = object(values[6], '正本narrative');
    let snapshot: BoardSnapshot;
    try {
        snapshot = projectBoard({
            registry,
            archive,
            state,
            events,
            updatedAt: 0,
            source: 'legacy',
        });
    } catch {
        throw new ParityError(
            '原票を表示投影へ変換できませんでした。原票の形式を確認してください',
        );
    }
    const actions = rows(registry.actions, '依頼');
    const tasks = rows(registry.tasks, 'タスク');
    const facts =
        state.facts === undefined
            ? {
                  sessions: {},
                  branches: {},
                  prs: {},
                  jira: {},
                  prsByBranch: {},
                  worktrees: [],
                  dirty: {},
                  warnings: [],
              }
            : object(state.facts, '事実キャッシュ');
    const isActionable = helper<[Row, Row], boolean>(
        registryModule,
        'isActionable',
    );
    const isHeldAction = helper<[Row, Row], boolean>(
        registryModule,
        'isHeldAction',
    );
    const isAwaitingResult = helper<[Row], boolean>(
        registryModule,
        'isAwaitingResult',
    );
    const sortActions = helper<[Row[]], Row[]>(registryModule, 'sortActions');
    const userActionKind = helper<[Row], string>(
        registryModule,
        'userActionKind',
    );
    const sortTasks = helper<[Row[]], Row[]>(renderModule, 'sortTasks');
    const formatTime = helper<[number], string>(renderModule, 'formatTime');
    const statusLines = helper<
        [Row, Row[], Row, (at: number) => string],
        string[]
    >(narrativeModule, 'statusLines');
    const cards = (id: string): BoardCard[] => {
        const section = snapshot.sections.find((s) => s.id === id);
        if (!section) throw new ParityError(`表示区分${id}がありません`);
        return section.cards;
    };
    const groups = [
        {
            id: 'execution',
            label: '実行待ち',
            test: (a: Row) =>
                isActionable(a, registry) && userActionKind(a) === 'execution',
        },
        {
            id: 'decision',
            label: '判断待ち',
            test: (a: Row) =>
                isActionable(a, registry) && userActionKind(a) === 'decision',
        },
        {
            id: 'held',
            label: '保留・前提待ち',
            test: (a: Row) => isHeldAction(a, registry),
        },
        { id: 'awaiting', label: '実行済み・結果待ち', test: isAwaitingResult },
    ];
    for (const group of groups)
        equal(
            cards(group.id).map((c) => c.id),
            ids(sortActions(actions.filter(group.test))),
            `${group.label}の分類と依頼順`,
        );
    equal(
        cards('tasks').map((c) => c.id),
        ids(
            sortTasks(
                tasks.filter(
                    (t) => !['保留', '完了'].includes(String(t.status)),
                ),
            ),
        ),
        '進行タスク順',
    );
    const projected = new Map(
        [...cards('tasks'), ...cards('held-tasks')].map((c) => [c.id, c]),
    );
    const unfinished = tasks.filter((t) => t.status !== '完了');
    for (const t of unfinished) {
        const card = projected.get(String(t.id));
        const status = card?.fields.find((f) => f.label === 'ステータス');
        if (!status)
            throw new ParityError('未完了タスクのステータス表示がありません');
        const expected = statusLines(t, events, facts, formatTime);
        equal(
            status.parts.slice(1, expected.length + 1).map((p) => p.text),
            expected,
            'ステータスの補足',
        );
        if (
            status.parts
                .slice(expected.length + 1)
                .some(
                    (p) =>
                        !/^(?:👤 実行待ち \d+ \/ 判断待ち \d+|⏸ 保留中の依頼 \d+|⏳ 結果の確認待ち \d+|✅ 完了候補)$/.test(
                            p.text,
                        ),
                )
        )
            throw new ParityError('ステータスの補足に正本にない行があります');
    }
    console.log(
        `検証成功: 依頼${actions.length}件、分類4区分、進行タスク${cards('tasks').length}件、未完了タスク補足${unfinished.length}件、アーカイブ${rows(archive.tasks, 'アーカイブタスク').length}件`,
    );
}

await main().catch((error: unknown) => {
    console.error(
        error instanceof ParityError
            ? error.message
            : '検証を完了できませんでした。正本の公開関数と原票の形式を確認してください',
    );
    process.exitCode = 1;
});
