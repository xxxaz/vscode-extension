import { createHash, randomUUID } from 'node:crypto';
import {
    type DocumentRecord,
    type ExecutionAttempt,
    type ExecutionReadResult,
    RECORD_LIMITS,
    type RecordCommand,
    type RecordOperation,
    type RecordRead,
    type RecordReadResult,
    type RecordResult,
} from './contracts/records.ts';
import {
    type CaptureLimits,
    type ObservedOutput,
    OutputNotStored,
} from './executionCapture.ts';
import type {
    ExecutionFacts,
    ExecutionPreview,
    RunnerPort,
} from './executionRunner.ts';
import type { ResultAccessAdapter } from './executionView.ts';

// transportが認可と正式CommandResultのapplied/code/idを検査した後の内部port。
// payloadやsourceからRecordCallerを生成しない。公開transportは未接続のまま。
export interface RecordChannel {
    submit(
        command: RecordCommand,
    ): Promise<{ record: RecordResult; taskVersion: number }>;
    read<Q extends RecordRead>(query: Q): Promise<RecordReadResult<Q['type']>>;
}
export interface PreparedExecution {
    readonly attempt: Readonly<ExecutionAttempt>;
    readonly preview: Readonly<ExecutionPreview>;
}
type UiPort = Pick<
    RunnerPort<PreparedExecution, PreparedExecution>,
    'allowed' | 'confirm' | 'reserveLocalLaunch' | 'launch' | 'status'
> & {
    showSaved(part: Readonly<ObservedOutput>): void;
    warning(message: string): void;
};
export const recordCaptureLimits: Readonly<CaptureLimits> = Object.freeze({
    pieceBytes: RECORD_LIMITS.chunkBytes,
    executionBytes: RECORD_LIMITS.attemptBytes,
    inputBytes: 64 * 1024,
    maxPieces: RECORD_LIMITS.chunks,
    ackTimeoutMs: 5000,
});
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const matchAttempt = (value: ExecutionReadResult, fixed: ExecutionAttempt) => {
    if (
        !('command' in value.attempt) ||
        Object.entries(fixed).some(
            ([key, v]) => Reflect.get(value.attempt, key) !== v,
        )
    )
        throw new Error('固定実行原票が一致しません');
};

export class RecordConnection {
    private taskVersion: number;
    private tail: Promise<unknown> = Promise.resolve();
    private readonly channel: RecordChannel;
    private readonly taskId: string;
    private readonly source: string;
    constructor(
        channel: RecordChannel,
        taskId: string,
        taskVersion: number,
        source: string,
    ) {
        if (
            !/^T[1-9]\d*$/.test(taskId) ||
            !Number.isSafeInteger(taskVersion) ||
            taskVersion < 0
        )
            throw new Error('更新用タスク版が不正です');
        this.taskVersion = taskVersion;
        this.channel = channel;
        this.taskId = taskId;
        this.source = source;
    }
    private send(operation: RecordOperation) {
        const pending = this.tail.then(async () => {
            const command: RecordCommand = {
                schemaVersion: 1,
                commandId: randomUUID(),
                targetId: this.taskId,
                expectedVersion: this.taskVersion,
                source: this.source,
                ...operation,
            };
            const receipt = await this.channel.submit(command);
            if (
                !Number.isSafeInteger(receipt.taskVersion) ||
                receipt.taskVersion < this.taskVersion
            )
                throw new Error('保存後のタスク版が不正です');
            this.taskVersion = receipt.taskVersion;
            return receipt.record;
        });
        // 応答不明・版競合の後に新版を取得して後続変更を送らない。
        this.tail = pending;
        return pending;
    }
    execution(attemptId: string) {
        return this.channel.read({
            schemaVersion: 1,
            requestId: randomUUID(),
            targetId: this.taskId,
            type: 'execution.read',
            attemptId,
        });
    }
    async document(
        documentId: string,
        revision: number,
    ): Promise<DocumentRecord> {
        const value = await this.channel.read({
            schemaVersion: 1,
            requestId: randomUUID(),
            targetId: this.taskId,
            type: 'document.read',
            documentId,
            revision,
        });
        if (
            value.documentId !== documentId ||
            value.revision !== revision ||
            value.taskId !== this.taskId ||
            value.sha256 !== sha(value.body) ||
            value.utf8Bytes !== Buffer.byteLength(value.body)
        )
            throw new Error('固定資料の照合が一致しません');
        return Object.freeze({ ...value });
    }
    async prepare(
        actionId: string,
        requestVersion: string,
        cwd: string,
        documents: readonly DocumentRecord[] = [],
    ): Promise<PreparedExecution> {
        const receipt = await this.send({
            type: 'execution.prepare',
            payload: { actionId, requestVersion },
        });
        if (!receipt.attemptId) throw new Error('保存された実行IDがありません');
        const value = await this.execution(receipt.attemptId);
        const a = value.attempt;
        if (
            !('command' in a) ||
            a.taskId !== this.taskId ||
            a.actionId !== actionId ||
            a.requestVersion !== requestVersion ||
            a.commandSha256 !== sha(a.command) ||
            a.executionWhere !== 'devcontainer' ||
            value.state.status !== 'prepared'
        )
            throw new Error('準備した固定版の実行原票を取得できません');
        for (const doc of documents)
            if (doc.taskId !== this.taskId || doc.sha256 !== sha(doc.body))
                throw new Error('資料の所属または固定本文が一致しません');
        return Object.freeze({
            attempt: Object.freeze({ ...a }),
            preview: Object.freeze({
                command: a.command,
                requestLabel: `${actionId} / ${a.attemptId}`,
                workingDirectory: cwd,
                documents: Object.freeze(
                    documents.map((d) =>
                        Object.freeze({
                            label: `${d.title} (${d.documentId}@${d.revision})`,
                            body: d.body,
                        }),
                    ),
                ),
            }),
        });
    }
    runner(ui: UiPort): RunnerPort<PreparedExecution, PreparedExecution> {
        const started = new Set<string>();
        const finished = new Map<string, ExecutionFacts>();
        const requireAttempt = (context: PreparedExecution) => context.attempt;
        return {
            ...ui,
            key: (c) => c.attempt.attemptId,
            preview: (c) => c.preview,
            claimedKey: (c) => c.attempt.attemptId,
            claimedPreview: (c) => c.preview,
            claim: async (context) => {
                const a = requireAttempt(context);
                await this.send({
                    type: 'execution.claim',
                    payload: {
                        attemptId: a.attemptId,
                        requestVersion: a.requestVersion,
                    },
                });
                const saved = await this.execution(a.attemptId);
                matchAttempt(saved, a);
                if (saved.state.status !== 'launching')
                    throw new Error('起動権の確定を確認できません');
                return context;
            },
            started: async (context, observation) => {
                if (
                    !observation.processIdentity ||
                    observation.startedAt === undefined
                )
                    throw new Error('実processの起動観測がありません');
                const a = requireAttempt(context);
                const ack = await this.send({
                    type: 'execution.started',
                    payload: {
                        attemptId: a.attemptId,
                        processIdentity: observation.processIdentity,
                        startedAt: observation.startedAt,
                    },
                });
                if (ack.status !== 'running')
                    throw new Error('開始記録の保存を確認できません');
                started.add(a.attemptId);
            },
            output: (context) => {
                const a = requireAttempt(context);
                return {
                    append: async (part) => {
                        const ack = await this.send({
                            type: 'execution.output',
                            payload: {
                                attemptId: a.attemptId,
                                seq: part.sequence,
                                stream: part.stream,
                                body: part.text,
                                capturedAt: Date.now(),
                            },
                        });
                        if (ack.stored === false && ack.drain === true)
                            throw new OutputNotStored(
                                'DBが出力の未保存を返しました',
                            );
                        if (ack.stored !== true || ack.seq !== part.sequence)
                            throw new Error('出力の保存ackが一致しません');
                        return ack.seq;
                    },
                    readSaved: async (sequence) => {
                        const result = await this.channel.read({
                            schemaVersion: 1,
                            requestId: randomUUID(),
                            targetId: this.taskId,
                            type: 'execution.output.read',
                            attemptId: a.attemptId,
                            afterSeq: sequence - 1,
                        });
                        const row = result.rows.find((r) => r.seq === sequence);
                        if (
                            !row ||
                            row.attemptId !== a.attemptId ||
                            row.sha256 !== sha(row.body) ||
                            row.utf8Bytes !== Buffer.byteLength(row.body)
                        )
                            throw new Error('保存出力を照合できません');
                        return {
                            sequence: row.seq,
                            stream: row.stream,
                            text: row.body,
                            byteLength: row.utf8Bytes,
                            sha256: row.sha256,
                        };
                    },
                    showSaved: ui.showSaved,
                    warning: ui.warning,
                };
            },
            finished: async (context, facts) => {
                const a = requireAttempt(context);
                finished.set(a.attemptId, structuredClone(facts));
                const t = facts.termination,
                    o = facts.output;
                const known = started.has(a.attemptId) && t.kind !== 'unknown';
                await this.send({
                    type: 'execution.finished',
                    payload: {
                        attemptId: a.attemptId,
                        outcome: known
                            ? t.kind === 'exit'
                                ? 'exited'
                                : 'signaled'
                            : 'unknown',
                        exitCode: known && t.kind === 'exit' ? t.code : null,
                        signal: known && t.kind === 'signal' ? t.signal : null,
                        lastSeq: o.lastSubmittedSequence,
                        complete: o.status === 'complete',
                        missingStdoutBytes:
                            known && o.uncertainStdoutBytes === 0
                                ? o.discardedStdoutBytes
                                : null,
                        missingStderrBytes:
                            known && o.uncertainStderrBytes === 0
                                ? o.discardedStderrBytes
                                : null,
                    },
                });
            },
            readFinished: async (context) => {
                const a = requireAttempt(context),
                    f = finished.get(a.attemptId);
                if (!f) throw new Error('今回の終了観測がありません');
                const saved = await this.execution(a.attemptId);
                matchAttempt(saved, a);
                const s = saved.state,
                    t = f.termination,
                    o = f.output;
                const expectedIntegrity =
                    o.status === 'complete'
                        ? 'complete'
                        : o.status === 'incomplete'
                          ? 'incomplete'
                          : null;
                if (
                    !s.result ||
                    s.result.outcome !==
                        (t.kind === 'exit'
                            ? 'exited'
                            : t.kind === 'signal'
                              ? 'signaled'
                              : 'unknown') ||
                    s.result.exitCode !== (t.kind === 'exit' ? t.code : null) ||
                    s.result.signal !==
                        (t.kind === 'signal' ? t.signal : null) ||
                    s.observedLastSeq !== o.lastSubmittedSequence ||
                    s.lastSeq !== o.lastAckSequence ||
                    s.capturedBytes !== o.savedBytes ||
                    (expectedIntegrity !== null &&
                        s.integrity !== expectedIntegrity) ||
                    s.missingStdoutBytes !==
                        (t.kind !== 'unknown' && o.uncertainStdoutBytes === 0
                            ? o.discardedStdoutBytes
                            : null) ||
                    s.missingStderrBytes !==
                        (t.kind !== 'unknown' && o.uncertainStderrBytes === 0
                            ? o.discardedStderrBytes
                            : null)
                )
                    throw new Error('終了事実と正式DBの保存結果が一致しません');
                return structuredClone(f);
            },
        };
    }
    disclosure(
        attemptId: string,
    ): ResultAccessAdapter<{ attemptId: string; revision: number }> {
        return {
            read: async () => {
                const value = await this.execution(attemptId),
                    d = value.state.disclosure;
                return {
                    context: { attemptId, revision: d.revision },
                    canChangeDisclosure: true,
                    userDisplay: '本人の認可を通した正式read',
                    databaseStorage:
                        value.state.integrity === 'complete'
                            ? '全文保存済み'
                            : value.state.status === 'prepared'
                              ? '実行前'
                              : value.state.integrity === 'incomplete'
                                ? '欠落あり'
                                : '未確定',
                    aiDisclosure: d.allow ? 'allowed' : 'denied',
                    resultConfirmation: '依頼の完了・結果確認OKとは別の設定',
                };
            },
            changeDisclosure: async (context, allow) => {
                if (context.attemptId !== attemptId)
                    throw new Error('開示設定の実行IDが一致しません');
                const ack = await this.send({
                    type: 'execution.disclosure',
                    payload: {
                        attemptId,
                        expectedRevision: context.revision,
                        allow,
                    },
                });
                const saved = await this.execution(attemptId);
                if (
                    ack.disclosureRevision !==
                        saved.state.disclosure.revision ||
                    saved.state.disclosure.allow !== allow
                )
                    throw new Error('開示設定の保存と読戻しが一致しません');
            },
        };
    }
}
