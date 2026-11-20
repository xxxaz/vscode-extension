import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { ActionGateway, RuntimeSelection } from './gateway.ts';

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
export const kind = (a: Action): 'execution' | 'decision' =>
    a.kind ?? (a.command?.trim() ? 'execution' : 'decision');
export const revision = (a: Action): string =>
    createHash('sha256').update(JSON.stringify(a)).digest('hex');
export function candidates(r: Registry, operation: Operation): Action[] {
    return r.actions
        .filter(
            (a) =>
                !a.done &&
                a.withdrawal === undefined &&
                !a.holdReason &&
                !(a.after ?? []).some((id) =>
                    r.actions.some((other) => other.id === id && !other.done),
                ),
        )
        .filter((a) =>
            operation === 'answer'
                ? kind(a) === 'decision' && !!a.taskId
                : kind(a) === 'execution' &&
                  (operation !== 'ran' ||
                      (a.needsOk === true && a.ranAt === undefined)),
        )
        .sort(
            (a, b) =>
                (a.priority === b.priority
                    ? 0
                    : a.priority === undefined
                      ? 1
                      : b.priority === undefined
                        ? -1
                        : a.priority - b.priority) ||
                (a.createdAt ?? 0) - (b.createdAt ?? 0) ||
                a.id.localeCompare(b.id, 'en', { numeric: true }),
        );
}
export class Ledger implements ActionGateway {
    readonly root: string;
    readonly run: (args: string[]) => Promise<string>;
    readonly guard: () => Promise<void>;
    constructor(
        root: string,
        run: (args: string[]) => Promise<string>,
        guard = async (): Promise<void> => {},
    ) {
        this.root = root;
        this.run = run;
        this.guard = guard;
    }
    async read(): Promise<Registry> {
        await this.guard();
        const r = JSON.parse(
            await readFile(
                join(this.root, '.agents/ローカルタスク/監督/registry.json'),
                'utf8',
            ),
        ) as Registry;
        if (r.version !== 1 || !Array.isArray(r.actions))
            throw new Error('未対応の台帳形式です');
        for (const a of r.actions)
            if (
                !/^U\d+[A-Z]*$/.test(a.id) ||
                typeof a.text !== 'string' ||
                typeof a.done !== 'boolean'
            )
                throw new Error('依頼の形式が不正です');
        return r;
    }
    async current(selected: Action, operation: Operation): Promise<Action> {
        const row = candidates(await this.read(), operation).find(
            (a) => a.id === selected.id,
        );
        if (!row || revision(row) !== revision(selected))
            throw new Error(
                '依頼が更新されました。未保存のため、最新の依頼を選び直してください',
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
    return async (args) =>
        (
            await exec(nodePath, [boardPath, ...args], {
                cwd: root,
                // biome-ignore lint/style/noProcessEnv: 拡張のCLI境界でホストの実行環境を継承し対象ルートだけ固定する。
                env: { ...process.env, CLAUDE_PROJECT_DIR: root },
                encoding: 'utf8',
                timeout: 120000,
                maxBuffer: 1024 * 1024,
            })
        ).stdout;
}
