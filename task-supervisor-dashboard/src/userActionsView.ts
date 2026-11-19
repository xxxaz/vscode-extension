import type { Action, Operation } from './boardClient.ts';

const sourceModes = ['legacy', 'shadow', 'authoritative'] as const;
const kinds = ['execution', 'decision'] as const;
const lifecycleValues = [
    'decision',
    'unexecuted',
    'executed',
    'awaiting-result',
    'completed',
    'withdrawn',
] as const;

export type UserActionSource = {
    mode: (typeof sourceModes)[number];
    epoch: string | null;
    fetchedAt: number | null;
};

type ReadError = { code: string; message: string };
type ViewAction = Omit<Action, 'runtime'> & Record<string, unknown>;
type ViewTask = { id: string; title: string; status: string } & Record<
    string,
    unknown
>;

export type UserActionRow = {
    id: string;
    version: string;
    action: ViewAction;
    task: ViewTask | null;
    kind: (typeof kinds)[number];
    lifecycle: (typeof lifecycleValues)[number];
    availability: {
        actionable: boolean;
        held: boolean;
        holdReason: string | null;
        pendingPrerequisites: string[];
    };
    operations: {
        execute: boolean;
        answer: boolean;
        complete: boolean;
        confirmResult: boolean;
    };
};

type UnavailableView = {
    schemaVersion: 1;
    viewVersion: string;
    status: 'unavailable';
    source: UserActionSource & { error: ReadError };
    rows: null;
};

export type UserActionsView =
    | UnavailableView
    | {
          schemaVersion: 1;
          viewVersion: string;
          status: 'ready';
          source: UserActionSource & { error: null };
          rows: UserActionRow[];
      };

export type UserActionsInfo = {
    status: UserActionsView['status'];
    viewVersion: string | null;
    source: UserActionSource & { error: ReadError | null };
    lastSuccessful?: { viewVersion: string; fetchedAt: number | null };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);
const isNonemptyString = (value: unknown): value is string =>
    typeof value === 'string' && value.length > 0;
const isFiniteNumber = (value: unknown): value is number =>
    typeof value === 'number' && Number.isFinite(value);
const isStringArray = (value: unknown): value is string[] =>
    Array.isArray(value) && value.every((item) => typeof item === 'string');
const isSourceMode = (value: unknown): value is UserActionSource['mode'] =>
    sourceModes.some((mode) => mode === value);

function isReadError(value: unknown): value is ReadError {
    return (
        isRecord(value) &&
        isNonemptyString(value.code) &&
        typeof value.message === 'string'
    );
}

function isAnswer(value: unknown): boolean {
    return (
        isRecord(value) &&
        ['commandId', 'answer', 'respondent', 'requestVersion'].every(
            (key) => typeof value[key] === 'string',
        )
    );
}

function isAction(value: unknown): value is ViewAction {
    return (
        isRecord(value) &&
        isNonemptyString(value.id) &&
        typeof value.text === 'string' &&
        typeof value.done === 'boolean' &&
        ['taskId', 'summary', 'command', 'doc', 'holdReason'].every(
            (key) => value[key] === undefined || typeof value[key] === 'string',
        ) &&
        ['ranAt', 'priority', 'createdAt'].every(
            (key) => value[key] === undefined || isFiniteNumber(value[key]),
        ) &&
        (value.kind === undefined ||
            kinds.some((kind) => kind === value.kind)) &&
        (value.needsOk === undefined || typeof value.needsOk === 'boolean') &&
        (value.after === undefined || isStringArray(value.after)) &&
        (value.answers === undefined ||
            (Array.isArray(value.answers) && value.answers.every(isAnswer)))
    );
}

function isTask(value: unknown): value is ViewTask {
    return (
        isRecord(value) &&
        isNonemptyString(value.id) &&
        typeof value.title === 'string' &&
        typeof value.status === 'string'
    );
}

function isRow(value: unknown): value is UserActionRow {
    if (
        !isRecord(value) ||
        !isAction(value.action) ||
        value.id !== value.action.id ||
        !isNonemptyString(value.version) ||
        (value.task !== null && !isTask(value.task)) ||
        !kinds.some((kind) => kind === value.kind) ||
        !lifecycleValues.some((lifecycle) => lifecycle === value.lifecycle)
    )
        return false;
    const { availability, operations } = value;
    return (
        isRecord(availability) &&
        typeof availability.actionable === 'boolean' &&
        typeof availability.held === 'boolean' &&
        (availability.holdReason === null ||
            typeof availability.holdReason === 'string') &&
        isStringArray(availability.pendingPrerequisites) &&
        isRecord(operations) &&
        typeof operations.execute === 'boolean' &&
        typeof operations.answer === 'boolean' &&
        typeof operations.complete === 'boolean' &&
        typeof operations.confirmResult === 'boolean' &&
        availability.actionable ===
            (operations.execute ||
                operations.answer ||
                operations.complete ||
                operations.confirmResult)
    );
}

function invalid(field: string): never {
    throw new Error(`依頼一覧の応答形式が不正です（${field}）`);
}

export function parseUserActionsView(value: unknown): UserActionsView {
    if (
        !isRecord(value) ||
        value.schemaVersion !== 1 ||
        !isNonemptyString(value.viewVersion)
    )
        invalid('schemaVersion / viewVersion');
    const { source } = value;
    if (!isRecord(source)) invalid('source');
    const { mode, epoch, fetchedAt, error } = source;
    if (
        !isSourceMode(mode) ||
        (epoch !== null && typeof epoch !== 'string') ||
        (fetchedAt !== null &&
            (!isFiniteNumber(fetchedAt) || Math.abs(fetchedAt) > 8.64e15))
    )
        invalid('source');
    const header = {
        ...value,
        schemaVersion: 1 as const,
        viewVersion: value.viewVersion,
    };
    const sourceInfo = { ...source, mode, epoch, fetchedAt };
    if (value.status === 'unavailable') {
        if (value.rows !== null || !isReadError(error))
            invalid('unavailable の rows / source.error');
        return {
            ...header,
            status: 'unavailable',
            source: { ...sourceInfo, error },
            rows: null,
        };
    }
    if (value.status !== 'ready') invalid('status');
    if (!Array.isArray(value.rows) || error !== null)
        invalid('ready の rows / source.error');
    const seen = new Set<string>();
    const rows: UserActionRow[] = [];
    for (const row of value.rows as unknown[]) {
        if (!isRow(row)) invalid(`rows[${rows.length}]`);
        if (seen.has(row.id)) invalid(`rows[${rows.length}].id の重複`);
        seen.add(row.id);
        rows.push(row);
    }
    return {
        ...header,
        status: 'ready',
        source: { ...sourceInfo, error },
        rows,
    };
}

export function viewOperations(row: UserActionRow): Operation[] {
    const { complete, confirmResult, execute, answer } = row.operations;
    const operations: Operation[] = [];
    if (complete || confirmResult) operations.push('complete');
    if (execute) operations.push('ran');
    if (answer) operations.push('answer');
    return operations;
}

export function viewInfo(view: UserActionsView): UserActionsInfo {
    const { status, viewVersion, source } = view;
    const { mode, epoch, fetchedAt, error } = source;
    return {
        status,
        viewVersion,
        source: {
            mode,
            epoch,
            fetchedAt,
            error: error && { code: error.code, message: error.message },
        },
    };
}

export class UserActionsUnavailable extends Error {
    readonly view: UnavailableView;

    constructor(view: UnavailableView) {
        const { code, message } = view.source.error;
        super(`依頼一覧を取得できません（${code}） ${message}`);
        this.name = 'UserActionsUnavailable';
        this.view = view;
    }
}
