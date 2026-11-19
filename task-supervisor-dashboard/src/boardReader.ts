import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Action, Registry } from './boardClient.ts';
import { projectBoard } from './boardModel.ts';
import type { BoardSnapshot } from './dashboardTypes.ts';
import type { ActionGateway } from './gateway.ts';
import { readAuthority, runtimeRelative } from './runtimeFiles.ts';
import type { Authority, RuntimeSnapshot } from './runtimeGateway.ts';

const ledgerRelative = '.agents/ローカルタスク/監督';
export const BOARD_FILES = [
    ...['registry.json', 'events.jsonl', 'state.json', 'archive.json'].map(
        (name) => `${ledgerRelative}/${name}`,
    ),
    ...['authority.json', 'snapshot.json', 'heartbeat.json'].map(
        (name) => `${runtimeRelative}/${name}`,
    ),
];
const HEARTBEAT_MAX_AGE_MS = 30_000;
class ChangedWhileReading extends Error {}

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

function registry(
    value: unknown,
): asserts value is Registry & { tasks: unknown[] } {
    if (
        !isRecord(value) ||
        value.version !== 1 ||
        !Array.isArray(value.tasks) ||
        !Array.isArray(value.actions)
    )
        throw new Error('監督台帳の形式が不正です');
    for (const row of value.actions) {
        if (
            !isRecord(row) ||
            typeof row.id !== 'string' ||
            !/^U\d+[A-Z]*$/.test(row.id) ||
            typeof row.text !== 'string' ||
            typeof row.done !== 'boolean'
        )
            throw new Error('監督台帳の依頼が不正です');
    }
}

function events(text: string, warnings: string[]): unknown[] {
    const lines = text.split('\n');
    const rows: unknown[] = [];
    for (let index = 0; index < lines.length; index++) {
        const line = lines[index];
        if (!line.trim()) continue;
        let row: unknown;
        try {
            row = JSON.parse(line);
        } catch {
            if (index === lines.length - 1 && !text.endsWith('\n')) {
                warnings.push(
                    '出来事ログの末尾が書込み途中のため、完了した行まで表示しています',
                );
                break;
            }
            throw new Error(`出来事ログの${index + 1}行目が破損しています`);
        }
        if (!isRecord(row))
            throw new Error(`出来事ログの${index + 1}行目の形式が不正です`);
        rows.push(row);
    }
    return rows;
}

async function stamp(path: string): Promise<string | undefined> {
    try {
        const value = await stat(path);
        if (!value.isFile())
            throw new Error('監督台帳の読取り対象がファイルではありません');
        return `${value.dev}:${value.ino}:${value.size}:${value.mtimeMs}:${value.ctimeMs}`;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT')
            return undefined;
        throw error;
    }
}

export class BoardReader {
    private seenAuthority = false;
    private readonly observedFiles = new Set<string>();
    private readonly root: string;
    private readonly options: {
        gateway: () => Promise<ActionGateway>;
        authoritySeen?: () => boolean;
        markAuthorityObserved?: (epoch: string) => Promise<void>;
        repoUrl?: string;
    };
    constructor(
        root: string,
        options: {
            gateway: () => Promise<ActionGateway>;
            authoritySeen?: () => boolean;
            markAuthorityObserved?: (epoch: string) => Promise<void>;
            repoUrl?: string;
        },
    ) {
        this.root = root;
        this.options = options;
    }

    async read(): Promise<BoardSnapshot> {
        for (let attempt = 0; attempt < 3; attempt++) {
            const paths = BOARD_FILES.map((path) => join(this.root, path));
            const before = await Promise.all(paths.map(stamp));
            try {
                const snapshot = await this.readOnce();
                const after = await Promise.all(paths.map(stamp));
                if (before.some((value, index) => value !== after[index]))
                    throw new ChangedWhileReading();
                return snapshot;
            } catch (error) {
                const after = await Promise.all(paths.map(stamp));
                if (
                    error instanceof ChangedWhileReading ||
                    before.some((value, index) => value !== after[index])
                )
                    continue;
                throw error;
            }
        }
        throw new Error(
            '監督台帳の更新が続いています。前回の表示を保持します。再読込みしてください',
        );
    }

    private async observeAuthority(): Promise<Authority | undefined> {
        let authority: Authority | undefined;
        try {
            authority = await readAuthority(this.root);
        } catch (error) {
            this.seenAuthority = true;
            await this.options.markAuthorityObserved?.('unreadable');
            throw error;
        }
        if (authority) {
            this.seenAuthority = true;
            await this.options.markAuthorityObserved?.(authority.epoch);
        }
        return authority;
    }

    private async readOnce(): Promise<BoardSnapshot> {
        const authority = await this.observeAuthority();
        if (
            !authority &&
            (this.seenAuthority || this.options.authoritySeen?.())
        )
            throw new Error(
                '正本の切替記録が消失しました。旧台帳へ戻さず前回の表示を保持します',
            );
        if (authority?.mode === 'preparing')
            throw new Error(
                '正本の切替準備中です。前回の表示を保持し、操作は切替完了後に再確認します',
            );
        const warnings: string[] = [];
        const modificationTimes: number[] = [];
        const load = async (
            relative: string,
            optional = false,
        ): Promise<string | undefined> => {
            const path = join(this.root, relative);
            let loaded = false;
            try {
                const text = await readFile(path, 'utf8');
                loaded = true;
                modificationTimes.push((await stat(path)).mtimeMs);
                this.observedFiles.add(relative);
                return text;
            } catch (error) {
                if (
                    !loaded &&
                    optional &&
                    !this.observedFiles.has(relative) &&
                    (error as NodeJS.ErrnoException).code === 'ENOENT'
                ) {
                    warnings.push(
                        `${relative.split('/').at(-1)} がないため初期空値で表示しています`,
                    );
                    return undefined;
                }
                throw error;
            }
        };
        const object = async (
            name: string,
            empty: unknown,
        ): Promise<unknown> => {
            const text = await load(`${ledgerRelative}/${name}`, true);
            if (text === undefined) return empty;
            const value: unknown = JSON.parse(text);
            if (!isRecord(value)) throw new Error(`${name} の形式が不正です`);
            return value;
        };
        let current: unknown;
        if (authority) {
            warnings.push(
                '常駐部の孤立・稼働・待機・報告の詳細表示は次段階で対応します。この一覧だけで正常とは判定しません',
            );
            await load(`${runtimeRelative}/authority.json`);
            const raw: unknown = JSON.parse(
                (await load(`${runtimeRelative}/snapshot.json`)) ?? '',
            );
            if (
                !isRecord(raw) ||
                raw.schemaVersion !== 1 ||
                raw.mode !== 'authoritative' ||
                typeof raw.generation !== 'string' ||
                !Array.isArray(raw.tasks)
            )
                throw new Error('常駐部の正本スナップショットの形式が不正です');
            registry(raw.registry);
            const runtime = raw as unknown as RuntimeSnapshot;
            const latest = await (await this.options.gateway()).read();
            const stripSelection = (actions: Action[]) =>
                actions.map(({ runtime: _runtime, ...action }) => action);
            if (
                JSON.stringify(stripSelection(latest.actions)) !==
                JSON.stringify(stripSelection(runtime.registry.actions))
            )
                throw new ChangedWhileReading();
            for (const action of latest.actions) {
                const task = runtime.tasks.find(
                    (task) => task.id === action.taskId,
                );
                if (
                    action.runtime &&
                    (action.runtime.epoch !== authority.epoch ||
                        action.runtime.taskId !== task?.id ||
                        action.runtime.version !== task?.version)
                )
                    throw new ChangedWhileReading();
                if (
                    task &&
                    Number.isSafeInteger(task.version) &&
                    task.version >= 0 &&
                    !action.runtime
                )
                    throw new Error('常駐部の操作対象の版を取得できません');
            }
            current = { ...runtime.registry, actions: latest.actions };
            const heartbeatText = await load(
                `${runtimeRelative}/heartbeat.json`,
                true,
            );
            if (heartbeatText === undefined) {
                warnings.push(
                    '常駐部の稼働を確認できません。保存済みスナップショットを参考表示しています',
                );
            } else {
                const heartbeat: unknown = JSON.parse(heartbeatText);
                if (
                    !isRecord(heartbeat) ||
                    heartbeat.schemaVersion !== 1 ||
                    typeof heartbeat.at !== 'number' ||
                    !Number.isFinite(heartbeat.at)
                )
                    throw new Error('常駐部の稼働記録が不正です');
                const age = Date.now() - heartbeat.at;
                if (
                    age < 0 ||
                    age > HEARTBEAT_MAX_AGE_MS ||
                    heartbeat.generation !== raw.generation
                )
                    warnings.push(
                        '常駐部の稼働記録が古いか現在の状態と一致しません。保存済みスナップショットを参考表示しています',
                    );
            }
        } else {
            current = JSON.parse(
                (await load(`${ledgerRelative}/registry.json`)) ?? '',
            );
            registry(current);
        }
        const [state, archive, eventText] = await Promise.all([
            object('state.json', { facts: {} }),
            object('archive.json', { tasks: [] }),
            load(`${ledgerRelative}/events.jsonl`, true),
        ]);
        if (
            !isRecord(archive) ||
            !Array.isArray(archive.tasks) ||
            !isRecord(state) ||
            (state.facts !== undefined && !isRecord(state.facts))
        )
            throw new Error('監督台帳の状態またはアーカイブの形式が不正です');
        const history = events(eventText ?? '', warnings);
        const latestAuthority = await this.observeAuthority();
        if (JSON.stringify(authority) !== JSON.stringify(latestAuthority))
            throw new ChangedWhileReading();
        return projectBoard({
            registry: current,
            archive,
            state,
            events: history,
            updatedAt: Math.max(...modificationTimes),
            source: authority ? 'authoritative' : 'legacy',
            readWarnings: warnings,
            repoUrl: this.options.repoUrl,
        });
    }
}
