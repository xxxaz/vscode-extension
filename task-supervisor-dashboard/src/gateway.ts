import type {
    Action,
    AnswerContext,
    Operation,
    PendingAnswer,
    Registry,
} from './boardClient.ts';

export interface RuntimeSelection {
    epoch: string;
    taskId: string;
    version: number;
}
export interface ResumedOperation {
    commandId: string;
    operation: Operation;
    message: string;
}
export interface ActionGateway {
    readonly root: string;
    read(): Promise<Registry>;
    complete(selected: Action, operation: 'complete' | 'ran'): Promise<void>;
    answerContext(
        selected: Action,
        documentVersion?: string,
    ): Promise<AnswerContext>;
    answer(pending: PendingAnswer): Promise<void>;
    hasAnswer(pending: PendingAnswer): Promise<boolean>;
    resume?(): Promise<ResumedOperation | undefined>;
}
export class OperationPending extends Error {}
