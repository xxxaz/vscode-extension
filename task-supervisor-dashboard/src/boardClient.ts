import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import type { ActionGateway, RuntimeSelection } from './gateway.ts';
import {
    parseUserActionsView,
    UserActionsUnavailable,
    type UserActionsView,
    viewOperations,
} from './userActionsView.ts';

export interface Action {
    id: string;
    taskId?: string;
    summary?: string;
    text: string;
    command?: string;
    kind?: 'execution' | 'decision';
    done: boolean;
    needsOk?: boolean;
    ranAt?: number;
    priority?: number;
    createdAt?: number;
    doc?: string;
    holdReason?: string;
    withdrawal?: unknown;
    after?: string[];
    runtime?: RuntimeSelection;
    answers?: {
        commandId: string;
        answer: string;
        respondent: string;
        requestVersion: string;
    }[];
}
export interface Registry {
    version: number;
    actions: Action[];
    userActions?: UserActionsView;
}
export interface AnswerContext {
    schemaVersion: 1;
    actionId: string;
    requestVersion: string;
    document: { ref: string; version: string } | null;
    request: { text: string; doc: string | null };
    runtime?: RuntimeSelection;
}
export interface PendingAnswer {
    id: string;
    answer: string;
    respondent: string;
    requestVersion: string;
    commandId: string;
    documentVersion?: string;
    confirmedResult: boolean;
    runtime?: RuntimeSelection;
}
export type Operation = 'complete' | 'ran' | 'answer';
export const revision = (a: Action): string =>
    createHash('sha256').update(JSON.stringify(a)).digest('hex');
export function candidates(r: Registry, operation: Operation): Action[] {
    const view = commonView(r);
    const byId = new Map(r.actions.map((action) => [action.id, action]));
    return view.rows
        .filter((row) => viewOperations(row).includes(operation))
        .map((row) => {
            const action = byId.get(row.id);
            if (!action) throw new Error('共通一覧と操作対象が一致しません');
            return action;
        });
}
export function commonView(r: Registry) {
    if (!r.userActions)
        throw new Error(
            '共通操作一覧を取得できません。対応するread CLIが必要です',
        );
    const view = parseUserActionsView(r.userActions);
    if (view.status === 'unavailable') throw new UserActionsUnavailable(view);
    return view;
}
export class Ledger implements ActionGateway {
    readonly root: string;
    readonly run: (args: string[]) => Promise<string>;
    readonly guard: () => Promise<void>;
    private readonly readView: () => Promise<UserActionsView>;
    constructor(
        root: string,
        run: (args: string[]) => Promise<string>,
        guard = async (): Promise<void> => {},
        readView?: () => Promise<UserActionsView>,
    ) {
        this.root = root;
        this.run = run;
        this.guard = guard;
        this.readView =
            readView ??
            (async () => {
                const output = await this.run(['user-actions', '--json']);
                try {
                    return parseUserActionsView(JSON.parse(output));
                } catch (error) {
                    throw new Error(
                        `共通操作一覧のread応答が不正です: ${String(error)}`,
                    );
                }
            });
    }
    async read(): Promise<Registry> {
        await this.guard();
        const view = parseUserActionsView(await this.readView());
        await this.guard();
        if (view.status === 'unavailable')
            throw new UserActionsUnavailable(view);
        if (view.source.mode === 'authoritative' || view.source.epoch !== null)
            throw new Error(
                '共通一覧の正本が変わりました。旧CLIへ変更しません',
            );
        return {
            version: 1,
            actions: view.rows.map(({ action }) => {
                const { runtime: _runtime, ...raw } = action;
                return raw;
            }),
            userActions: view,
        };
    }
    async current(selected: Action, operation: Operation): Promise<Action> {
        const registry = await this.read();
        const row = candidates(registry, operation).find(
            (a) => a.id === selected.id,
        );
        if (!row || revision(row) !== revision(selected))
            throw new Error(
                '依頼が更新されました。未保存のため、最新の依頼を選び直してください',
            );
        if (
            operation === 'complete' &&
            commonView(registry).rows.find((item) => item.id === row.id)
                ?.kind === 'decision'
        )
            throw new Error(
                '判断の推奨完了は回答contextを通して記録してください',
            );
        return row;
    }
    async complete(
        selected: Action,
        operation: 'complete' | 'ran',
    ): Promise<void> {
        const row = await this.current(selected, operation);
        await this.run([
            operation === 'complete' ? 'done' : 'ran',
            row.id,
            ...(operation === 'complete' && row.needsOk ? ['--ok'] : []),
        ]);
        const saved = (await this.read()).actions.find((a) => a.id === row.id);
        if (
            !saved ||
            (operation === 'complete' ? !saved.done : saved.ranAt === undefined)
        )
            throw new Error(
                'CLIは終了しましたが、台帳の記録を確認できません。再操作する前に台帳を確認してください',
            );
    }
    async answerContext(
        row: Action,
        documentVersion?: string,
    ): Promise<AnswerContext> {
        await this.current(row, 'answer');
        const output = await this.run([
            'answer-context',
            row.id,
            ...(documentVersion ? ['--document-version', documentVersion] : []),
        ]);
        let context: AnswerContext;
        try {
            context = JSON.parse(output) as AnswerContext;
        } catch {
            throw new Error(
                '回答APIが未対応です。answer-context/answer対応版board.tsへ更新してください',
            );
        }
        if (
            context.schemaVersion !== 1 ||
            context.actionId !== row.id ||
            !/^[a-f0-9]{64}$/.test(context.requestVersion)
        )
            throw new Error(
                '回答APIが未対応、または応答形式が不正です。answer-context/answer対応版board.tsが必要です',
            );
        return context;
    }
    async answer(pending: PendingAnswer): Promise<void> {
        if (pending.runtime)
            throw new Error('常駐部へ送った回答を旧CLIへ再送できません');
        await this.guard();
        await this.run([
            'answer',
            pending.id,
            '--answer',
            pending.answer,
            '--respondent',
            pending.respondent,
            '--request-version',
            pending.requestVersion,
            '--command-id',
            pending.commandId,
            ...(pending.documentVersion
                ? ['--document-version', pending.documentVersion]
                : []),
            ...(pending.confirmedResult ? ['--ok'] : []),
        ]);
        if (!(await this.hasAnswer(pending)))
            throw new Error(
                '回答の保存を台帳で確認できませんでした。下書きと同じ操作IDを保持します',
            );
    }
    async hasAnswer(pending: PendingAnswer): Promise<boolean> {
        const row = (await this.read()).actions.find(
            (a) => a.id === pending.id,
        );
        return (
            !!row?.done &&
            !!row.answers?.some(
                (a) =>
                    a.commandId === pending.commandId &&
                    a.answer === pending.answer &&
                    a.respondent === pending.respondent &&
                    a.requestVersion === pending.requestVersion,
            )
        );
    }
}
export function boardRunner(
    root: string,
    nodePath: string,
    boardPath: string,
): (args: string[]) => Promise<string> {
    const exec = promisify(execFile);
    return async (args) => {
        try {
            return (
                await exec(nodePath, [boardPath, ...args], {
                    cwd: root,
                    // biome-ignore lint/style/noProcessEnv: 拡張のCLI境界でホストの実行環境を継承し対象ルートだけ固定する。
                    env: { ...process.env, CLAUDE_PROJECT_DIR: root },
                    encoding: 'utf8',
                    timeout: 120000,
                    maxBuffer: 16 * 1024 * 1024,
                })
            ).stdout;
        } catch (error) {
            if (
                args.length === 2 &&
                args[0] === 'user-actions' &&
                args[1] === '--json' &&
                error instanceof Error &&
                'code' in error &&
                error.code === 1 &&
                'stdout' in error &&
                typeof error.stdout === 'string'
            ) {
                let view: UserActionsView;
                try {
                    view = parseUserActionsView(JSON.parse(error.stdout));
                } catch {
                    throw error;
                }
                if (view.status === 'unavailable')
                    throw new UserActionsUnavailable(view);
            }
            throw error;
        }
    };
}
