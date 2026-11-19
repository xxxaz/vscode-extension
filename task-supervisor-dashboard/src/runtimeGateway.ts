import { randomUUID } from 'node:crypto';
import {
    type Action,
    type AnswerContext,
    candidates,
    commonView,
    type Operation,
    type PendingAnswer,
    type Registry,
    revision,
} from './boardClient.ts';
import {
    type ActionGateway,
    OperationPending,
    type ResumedOperation,
    type RuntimeSelection,
} from './gateway.ts';
import {
    parseUserActionsView,
    UserActionsUnavailable,
    type UserActionsView,
} from './userActionsView.ts';

export type Authority = {
    schemaVersion: 1;
    mode: 'preparing' | 'authoritative';
    epoch: string;
    migrationId: string;
    fingerprint: string;
};
export type RuntimeCommand = {
    schemaVersion: 1;
    commandId: string;
    targetId: string;
    expectedVersion: number;
    source: string;
} & (
    | {
          type: 'action.complete';
          payload: { actionId: string; confirmedResult: boolean };
      }
    | { type: 'action.executed'; payload: { actionId: string } }
    | {
          type: 'action.answer';
          payload: {
              actionId: string;
              answer: string;
              respondent: string;
              requestVersion: string;
              documentVersion?: string;
              confirmedResult: boolean;
          };
      }
);
export interface RuntimeSnapshot {
    schemaVersion: 1;
    mode: 'legacy' | 'shadow' | 'authoritative';
    generation: string;
    registry: Registry;
    userActions?: UserActionsView;
    tasks: { id: string; version: number }[];
}

export function snapshotRegistry(
    snapshot: RuntimeSnapshot,
    epoch?: string,
): Registry {
    if (
        snapshot.schemaVersion !== 1 ||
        typeof snapshot.generation !== 'string' ||
        !Array.isArray(snapshot.tasks) ||
        snapshot.registry?.version !== 1 ||
        !Array.isArray(snapshot.registry.actions)
    )
        throw new Error('常駐部の正本スナップショットを取得できません');
    const view = parseUserActionsView(snapshot.userActions);
    if (
        view.source.mode !== snapshot.mode ||
        (snapshot.mode === 'authoritative' &&
            (!epoch || view.source.epoch !== epoch)) ||
        (snapshot.mode !== 'authoritative' && epoch !== undefined)
    )
        throw new Error('共通一覧と正本のモード・世代が一致しません');
    if (view.status === 'unavailable') throw new UserActionsUnavailable(view);
    const versions = new Map<string, number>();
    for (const task of snapshot.tasks) {
        if (
            typeof task.id !== 'string' ||
            !Number.isSafeInteger(task.version) ||
            task.version < 0 ||
            versions.has(task.id)
        )
            throw new Error('常駐部のタスク版が不正です');
        versions.set(task.id, task.version);
    }
    return {
        ...snapshot.registry,
        actions: view.rows.map(({ action }) => {
            const { runtime: _runtime, ...raw } = action;
            const version = raw.taskId ? versions.get(raw.taskId) : undefined;
            return {
                ...raw,
                ...(epoch && raw.taskId && version !== undefined
                    ? {
                          runtime: { epoch, taskId: raw.taskId, version },
                      }
                    : {}),
            };
        }),
        userActions: view,
    };
}
export interface Receipt {
    commandId: string;
    status: 'queued';
    resultPath: string;
}
export interface RuntimeResult {
    schemaVersion: 1;
    commandId: string;
    status: 'applied' | 'rejected';
    code: string;
    version?: number;
    message: string;
}
export interface PendingRuntime {
    epoch: string;
    command: RuntimeCommand;
    receipt?: Receipt;
}
export interface RuntimeJournal {
    get(): PendingRuntime | undefined;
    set(value: PendingRuntime | undefined): Promise<void>;
}
export type RuntimeAnswerContext = AnswerContext & { taskVersion: number };
export interface RuntimePorts {
    authority(): Promise<Authority | undefined>;
    snapshot(): Promise<RuntimeSnapshot>;
    capabilities(): Promise<{
        schemaVersion: 1;
        authoritativeWrites: boolean;
        operations: string[];
    }>;
    submit(command: RuntimeCommand): Promise<Receipt>;
    result(receipt: Receipt): Promise<RuntimeResult | undefined>;
    answerContext(
        action: Action,
        documentVersion?: string,
    ): Promise<RuntimeAnswerContext>;
    journal: RuntimeJournal;
}

const operation = (type: RuntimeCommand['type']): Operation =>
    type === 'action.complete'
        ? 'complete'
        : type === 'action.executed'
          ? 'ran'
          : 'answer';

export class RuntimeGateway implements ActionGateway {
    readonly root: string;
    private readonly epoch: string;
    private readonly ports: RuntimePorts;
    constructor(root: string, epoch: string, ports: RuntimePorts) {
        this.root = root;
        this.epoch = epoch;
        this.ports = ports;
    }
    private async guard(epoch = this.epoch): Promise<void> {
        const authority = await this.ports.authority();
        if (
            authority?.mode !== 'authoritative' ||
            authority.epoch !== epoch ||
            epoch !== this.epoch
        )
            throw new Error(
                '正本の切替状態が変わりました。自動再送や旧CLIへの書戻しは行いません',
            );
    }
    async read(): Promise<Registry> {
        await this.guard();
        const s = await this.ports.snapshot();
        if (s.mode !== 'authoritative')
            throw new Error('常駐部の正本スナップショットを取得できません');
        const registry = snapshotRegistry(s, this.epoch);
        await this.guard();
        return registry;
    }
    private selected(action: Action): RuntimeSelection {
        const selection = action.runtime;
        if (
            !selection ||
            selection.epoch !== this.epoch ||
            selection.taskId !== action.taskId ||
            !/^T\d+$/.test(selection.taskId) ||
            !Number.isSafeInteger(selection.version) ||
            selection.version < 0
        )
            throw new Error(
                '常駐部で対象タスクの版を確認できません。単独依頼は未対応です',
            );
        return selection;
    }
    private async current(
        action: Action,
        op: Operation,
    ): Promise<RuntimeSelection> {
        const registry = await this.read();
        const latest = candidates(registry, op).find((a) => a.id === action.id);
        if (!latest || revision(latest) !== revision(action))
            throw new Error(
                '依頼またはタスクの版が変わりました。最新の依頼を選び直してください',
            );
        if (
            op === 'complete' &&
            commonView(registry).rows.find((row) => row.id === action.id)
                ?.kind === 'decision'
        )
            throw new Error(
                '判断の推奨完了は回答contextを通して記録してください',
            );
        return this.selected(action);
    }
    private async capability(type: RuntimeCommand['type']): Promise<void> {
        const c = await this.ports.capabilities();
        if (
            c.schemaVersion !== 1 ||
            c.authoritativeWrites !== true ||
            !Array.isArray(c.operations) ||
            !c.operations.includes(type)
        )
            throw new Error(
                `常駐部は ${type} の受付に未対応です。旧CLIで代用しません`,
            );
    }
    private async finish(pending: PendingRuntime): Promise<void> {
        const command = pending.command;
        if (
            command.schemaVersion !== 1 ||
            !['action.complete', 'action.executed', 'action.answer'].includes(
                command.type,
            ) ||
            !/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(command.commandId) ||
            !/^T\d+$/.test(command.targetId) ||
            !/^U\d+[A-Z]*$/.test(command.payload.actionId) ||
            !Number.isSafeInteger(command.expectedVersion) ||
            command.expectedVersion < 0 ||
            command.source !== 'vscode.task-supervisor'
        )
            throw new Error(
                '保持した操作の形式が不正です。別の操作へ変換せず停止します',
            );
        await this.guard(pending.epoch);
        if (!pending.receipt) {
            await this.capability(pending.command.type);
            const receipt = await this.ports.submit(pending.command);
            if (
                receipt.commandId !== pending.command.commandId ||
                receipt.status !== 'queued'
            )
                throw new Error(
                    '常駐部の受付確認が不正です。同じ操作IDを保持します',
                );
            pending = { ...pending, receipt };
            await this.ports.journal.set(pending);
        }
        const receipt = pending.receipt;
        if (!receipt)
            throw new Error(
                '保持した受付結果がありません。同じ操作IDを保持します',
            );
        const result = await this.ports.result(receipt);
        if (!result)
            throw new OperationPending(
                `受付済み・適用結果待ちです (${pending.command.commandId})。次の操作で同じIDの結果を照会します`,
            );
        if (
            result.schemaVersion !== 1 ||
            result.commandId !== pending.command.commandId ||
            !['applied', 'rejected'].includes(result.status)
        )
            throw new Error(
                '常駐部の結果形式が不正です。同じ操作IDを保持します',
            );
        if (result.status === 'rejected') {
            await this.ports.journal.set(undefined);
            throw new Error(
                `常駐部が操作を拒否しました (${result.code}): ${result.message}`,
            );
        }
        if (result.code !== 'ok')
            throw new Error(
                '適用結果のコードが不正です。同じ操作IDを保持します',
            );
        await this.ports.journal.set(undefined);
    }
    private async send(
        command: RuntimeCommand,
        selection: RuntimeSelection,
    ): Promise<void> {
        if (
            new TextEncoder().encode(JSON.stringify(command)).length >
            256 * 1024
        )
            throw new Error(
                '操作が常駐受付のサイズ上限を超えています。回答を見直してください',
            );
        if (this.ports.journal.get())
            throw new Error(
                '前の操作の結果が未確定です。先に同じ操作IDの結果を確認してください',
            );
        await this.guard(selection.epoch);
        await this.capability(command.type);
        const pending = { epoch: selection.epoch, command };
        await this.ports.journal.set(pending);
        await this.finish(pending);
    }
    async resume(): Promise<ResumedOperation | undefined> {
        const pending = this.ports.journal.get();
        if (!pending) return undefined;
        await this.finish(pending);
        return {
            commandId: pending.command.commandId,
            operation: operation(pending.command.type),
            message: `${pending.command.payload.actionId} の操作は常駐部で適用済みです（担当の受領・処理完了とは別です）`,
        };
    }
    async complete(action: Action, op: 'complete' | 'ran'): Promise<void> {
        const s = await this.current(action, op);
        const base = {
            schemaVersion: 1 as const,
            commandId: randomUUID(),
            targetId: s.taskId,
            expectedVersion: s.version,
            source: 'vscode.task-supervisor',
        };
        await this.send(
            op === 'complete'
                ? {
                      ...base,
                      type: 'action.complete',
                      payload: {
                          actionId: action.id,
                          confirmedResult: !!action.needsOk,
                      },
                  }
                : {
                      ...base,
                      type: 'action.executed',
                      payload: { actionId: action.id },
                  },
            s,
        );
    }
    async answerContext(
        action: Action,
        documentVersion?: string,
    ): Promise<AnswerContext> {
        const s = await this.current(action, 'answer');
        await this.capability('action.answer');
        const context = await this.ports.answerContext(action, documentVersion);
        if (
            context.schemaVersion !== 1 ||
            context.actionId !== action.id ||
            !/^[a-f0-9]{64}$/.test(context.requestVersion)
        )
            throw new Error('常駐部の回答用の版を取得できません');
        if (
            !Number.isSafeInteger(context.taskVersion) ||
            context.taskVersion < 0 ||
            context.taskVersion !== s.version
        )
            throw new Error(
                '回答の読取り中にタスクの版が変わりました。依頼を選び直してください',
            );
        return { ...context, runtime: s };
    }
    async answer(pending: PendingAnswer): Promise<void> {
        const s = pending.runtime;
        if (
            !s ||
            s.epoch !== this.epoch ||
            !/^T\d+$/.test(s.taskId) ||
            !Number.isSafeInteger(s.version) ||
            s.version < 0
        )
            throw new Error(
                '切替前の回答を新しい正本へ自動送信できません。依頼を確認して入力し直してください',
            );
        await this.send(
            {
                schemaVersion: 1,
                commandId: pending.commandId,
                targetId: s.taskId,
                expectedVersion: s.version,
                source: 'vscode.task-supervisor',
                type: 'action.answer',
                payload: {
                    actionId: pending.id,
                    answer: pending.answer,
                    respondent: pending.respondent,
                    requestVersion: pending.requestVersion,
                    confirmedResult: pending.confirmedResult,
                    ...(pending.documentVersion
                        ? { documentVersion: pending.documentVersion }
                        : {}),
                },
            },
            s,
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
