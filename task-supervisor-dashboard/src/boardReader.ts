import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { commonView, type Registry } from './boardClient.ts';
import { projectBoard } from './boardModel.ts';
import type { BoardSnapshot } from './dashboardTypes.ts';
import type { ActionGateway } from './gateway.ts';
import { readAuthority, runtimeRelative } from './runtimeFiles.ts';
import {
    type Authority,
    type RuntimeSnapshot,
    snapshotRegistry,
} from './runtimeGateway.ts';
import {
    parseUserActionsView,
    UserActionsUnavailable,
    type UserActionsView,
} from './userActionsView.ts';

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
    private seenRuntime = false;
    private readonly observedFiles = new Set<string>();
    private readonly root: string;
    private readonly options: {
        gateway: () => Promise<ActionGateway>;
        authoritySeen?: () => boolean;
        markAuthorityObserved?: (epoch: string) => Promise<void>;
        repoUrl?: string;
        legacyView?: () => Promise<UserActionsView>;
    };
    constructor(
        root: string,
        options: {
            gateway: () => Promise<ActionGateway>;
            authoritySeen?: () => boolean;
            markAuthorityObserved?: (epoch: string) => Promise<void>;
            repoUrl?: string;
            legacyView?: () => Promise<UserActionsView>;
        },
    ) {
        this.root = root;
        this.options = options;
    }

    usesRuntimeSnapshot(): boolean {
        return this.seenRuntime;
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
        let userActions: UserActionsView;
        let source: BoardSnapshot['source'];
        const runtimeExists = await stamp(
            join(this.root, runtimeRelative, 'snapshot.json'),
        );
        if (authority || runtimeExists || this.seenRuntime) {
            this.seenRuntime = true;
            warnings.push(
                '常駐部の孤立・稼働・待機・報告の詳細表示は次段階で対応します。この一覧だけで正常とは判定しません',
            );
            if (authority) await load(`${runtimeRelative}/authority.json`);
            const raw: unknown = JSON.parse(
                (await load(`${runtimeRelative}/snapshot.json`)) ?? '',
            );
            if (
                !isRecord(raw) ||
                raw.schemaVersion !== 1 ||
                !['legacy', 'shadow', 'authoritative'].includes(
                    String(raw.mode),
                ) ||
                typeof raw.generation !== 'string' ||
                !Array.isArray(raw.tasks)
            )
                throw new Error('常駐部の正本スナップショットの形式が不正です');
            registry(raw.registry);
            const runtime = raw as unknown as RuntimeSnapshot;
            if (!authority && runtime.mode === 'authoritative') {
                this.seenAuthority = true;
                await this.options.markAuthorityObserved?.(
                    'snapshot-authoritative',
                );
                throw new Error(
                    '正本スナップショットに対応する切替記録が消失しました。旧台帳へ戻しません',
                );
            }
            if (authority && runtime.mode !== 'authoritative')
                throw new Error(
                    '常駐部の正本スナップショットのモードが一致しません',
                );
            const selected = snapshotRegistry(runtime, authority?.epoch);
            userActions = commonView(selected);
            current = { ...runtime.registry, ...selected };
            source = runtime.mode;
            const heartbeatText = await load(
                `${runtimeRelative}/heartbeat.json`,
            );
            {
                const heartbeat: unknown = JSON.parse(heartbeatText ?? '');
                if (
                    !isRecord(heartbeat) ||
                    heartbeat.schemaVersion !== 1 ||
                    typeof heartbeat.at !== 'number' ||
                    !Number.isFinite(heartbeat.at)
                )
                    throw new Error('常駐部の稼働記録が不正です');
                if (
                    typeof heartbeat.authorityError === 'string' &&
                    heartbeat.authorityError
                )
                    throw new Error(
                        `常駐部の正本を確認できません: ${heartbeat.authorityError}`,
                    );
                const age = Date.now() - heartbeat.at;
                if (
                    age < 0 ||
                    age > HEARTBEAT_MAX_AGE_MS ||
                    heartbeat.generation !== raw.generation ||
                    heartbeat.snapshotError ||
                    heartbeat.authorityError
                )
                    throw new Error(
                        '常駐部の稼働を確認できません。稼働記録の時刻・世代・スナップショット保存結果を確認してください',
                    );
            }
        } else {
            current = JSON.parse(
                (await load(`${ledgerRelative}/registry.json`)) ?? '',
            );
            registry(current);
            const view = this.options.legacyView
                ? parseUserActionsView(await this.options.legacyView())
                : commonView(await (await this.options.gateway()).read());
            if (view.status === 'unavailable')
                throw new UserActionsUnavailable(view);
            if (view.source.mode !== 'legacy' || view.source.epoch !== null)
                throw new Error(
                    '旧台帳の共通一覧と正本のモード・世代が一致しません',
                );
            userActions = view;
            current = {
                ...current,
                actions: view.rows.map(({ action }) => {
                    const { runtime: _runtime, ...raw } = action;
                    return raw;
                }),
            };
            source = 'legacy';
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
            userActions,
            archive,
            state,
            events: history,
            updatedAt: Math.max(...modificationTimes),
            source,
            readWarnings: warnings,
            repoUrl: this.options.repoUrl,
        });
    }
}
