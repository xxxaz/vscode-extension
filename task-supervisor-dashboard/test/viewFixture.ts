import type { Action } from '../src/boardClient.ts';
import type { UserActionRow, UserActionsView } from '../src/userActionsView.ts';

export type RowState = Pick<
    UserActionRow,
    'kind' | 'lifecycle' | 'availability' | 'operations'
>;

export const noOperations = {
    execute: false,
    answer: false,
    complete: false,
    confirmResult: false,
};

export const actionable = {
    actionable: true,
    held: false,
    holdReason: null,
    pendingPrerequisites: [],
};

export const waitingForExecution = {
    kind: 'execution',
    lifecycle: 'unexecuted',
    availability: actionable,
    operations: { ...noOperations, execute: true },
} satisfies RowState;

export const awaitingResult = {
    kind: 'execution',
    lifecycle: 'awaiting-result',
    availability: actionable,
    operations: { ...noOperations, confirmResult: true },
} satisfies RowState;

export const waitingForDecision = {
    kind: 'decision',
    lifecycle: 'decision',
    availability: actionable,
    operations: { ...noOperations, answer: true, complete: true },
} satisfies RowState;

export function viewRow(
    action: Action,
    state: RowState,
    task: UserActionRow['task'] = null,
): UserActionRow {
    return {
        id: action.id,
        version: '依頼の表示版/1',
        action: { ...action },
        task,
        ...state,
    };
}

export function readyView(
    rows: UserActionRow[],
    source: Extract<UserActionsView, { status: 'ready' }>['source'] = {
        mode: 'legacy',
        epoch: null,
        fetchedAt: 1000,
        error: null,
    },
): Extract<UserActionsView, { status: 'ready' }> {
    return {
        schemaVersion: 1,
        status: 'ready',
        viewVersion: '一覧の表示版/1',
        source,
        rows,
    };
}
