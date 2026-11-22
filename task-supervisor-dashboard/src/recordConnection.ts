import { createHash, randomUUID } from 'node:crypto';
import {
    type DocumentRecord,
    type ExecutionAttempt,
    type ExecutionReadResult,
    RECORD_LIMITS,
    type RecordCommand,
    type RecordCommandHeader,
    type RecordOperation,
    type RecordRead,
    type RecordReadResult,
    type RecordResult,
} from './contracts/records.ts';
import {
    type CaptureLimits,
    KnownNotApplied,
    type ObservedOutput,
    OutputNotStored,
    withDeadline,
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
    // 正式request-context同一readから作る内部projection。UIの本文を正本へ代入しない。
    review(actionId: string): Promise<
        Pick<RecordCommandHeader, 'targetId'> & {
            input: Extract<
                RecordOperation,
                { type: 'execution.prepare' }
            >['payload'];
            command: string;
            taskVersion: number;
        }
    >;
    submit(
        command: RecordCommand,
    ): Promise<{ record: RecordResult; taskVersion: number }>;
    read<Q extends RecordRead>(query: Q): Promise<RecordReadResult<Q['type']>>;
}
export interface PreparedExecution {
    readonly attempt: Readonly<ExecutionAttempt>;
    readonly preview: Readonly<ExecutionPreview>;
}
export interface PrepareApproval {
    allowed(): Promise<boolean>;
    confirm(preview: Readonly<ExecutionPreview>): Promise<boolean>;
    // DB受付前に小さいprepare操作とIDを保存する。本文・出力を別正本へ複製しない。
    keepReference(command: Readonly<RecordCommand>): Promise<void>;
}
// 正式な非適用拒否を確認したtransportだけが使用する。通信不明と混同しない。
export class KnownRecordRejection extends KnownNotApplied {
    readonly taskVersionConflict: boolean;
    constructor(message: string, taskVersionConflict = false) {
        super(message);
        this.taskVersionConflict = taskVersionConflict;
    }
}
type UiPort = Pick<
    RunnerPort<PreparedExecution, PreparedExecution>,
    'allowed' | 'reserveLocalLaunch' | 'launch' | 'status'
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
    private writable = true;
    private readonly issued = new WeakSet<PreparedExecution>();
    private readonly channel: RecordChannel;
    private readonly taskId: string;
    private readonly source: string;
    private readonly responseTimeoutMs: number;
    constructor(
        channel: RecordChannel,
        taskId: string,
        taskVersion: number,
        source: string,
        responseTimeoutMs = recordCaptureLimits.ackTimeoutMs,
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
        if (!Number.isSafeInteger(responseTimeoutMs) || responseTimeoutMs <= 0)
            throw new Error('受付期限は正の整数が必要です');
        this.responseTimeoutMs = responseTimeoutMs;
    }
    private send(
        operation: RecordOperation,
        beforeSend?: (command: Readonly<RecordCommand>) => Promise<void>,
    ) {
        const pending = this.tail.then(async () => {
            if (!this.writable)
                throw new Error(
                    '受付の結果不明またはTask版競合です。変更を停止しています',
                );
            const command: RecordCommand = {
                schemaVersion: 1,
                commandId: randomUUID(),
                targetId: this.taskId,
                expectedVersion: this.taskVersion,
                source: this.source,
                ...operation,
            };
            if (beforeSend)
                await withDeadline(
                    beforeSend(Object.freeze(structuredClone(command))),
                    this.responseTimeoutMs,
                );
            if (!this.writable) throw new Error('送信前に受付が停止しました');
            let receipt: Awaited<ReturnType<RecordChannel['submit']>>;
            try {
                receipt = await withDeadline(
                    this.channel.submit(command),
                    this.responseTimeoutMs,
                );
            } catch (error) {
                if (
                    !(error instanceof KnownRecordRejection) ||
                    error.taskVersionConflict
                )
                    this.writable = false;
                throw error;
            }
            if (
                !Number.isSafeInteger(receipt.taskVersion) ||
                receipt.taskVersion < this.taskVersion
            ) {
                this.writable = false;
                throw new Error('保存後のタスク版が不正です');
            }
            this.taskVersion = receipt.taskVersion;
            return receipt.record;
        });
        // 既知の拒否だけは明示read後の新しい操作を許す。不明/Task版競合は停止する。
        this.tail = pending.catch(() => undefined);
        return pending;
    }
    private read<Q extends RecordRead>(
        query: Q,
    ): Promise<RecordReadResult<Q['type']>> {
        return withDeadline(this.channel.read(query), this.responseTimeoutMs);
    }
    execution(attemptId: string) {
        return this.read({
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
        const value = await this.read({
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
        documents: readonly DocumentRecord[],
        approval: PrepareApproval,
    ): Promise<PreparedExecution | null> {
        const review = await withDeadline(
            this.channel.review(actionId),
            this.responseTimeoutMs,
        );
        if (
            review.targetId !== this.taskId ||
            review.input.actionId !== actionId ||
            review.input.requestVersion !== requestVersion ||
            review.taskVersion !== this.taskVersion
        )
            throw new Error('確認する本文と正式な依頼版・Task版が一致しません');
        for (const doc of documents)
            if (doc.taskId !== this.taskId || doc.sha256 !== sha(doc.body))
                throw new Error('資料の所属または固定本文が一致しません');
        const preview = Object.freeze({
            command: review.command,
            requestLabel: actionId,
            workingDirectory: cwd,
            documents: Object.freeze(
                documents.map((d) =>
                    Object.freeze({
                        label: `${d.title} (${d.documentId}@${d.revision})`,
                        body: d.body,
                    }),
                ),
            ),
        });
        if (
            !preview.command.trim() ||
            !cwd ||
            !(await withDeadline(approval.allowed(), this.responseTimeoutMs))
        )
            return null;
        if (!(await approval.confirm(preview))) return null;
        if (!(await withDeadline(approval.allowed(), this.responseTimeoutMs)))
            return null;
        const receipt = await this.send(
            {
                type: 'execution.prepare',
                payload: { actionId, requestVersion },
            },
            async (c) => {
                await approval.keepReference(c);
                const latest = await withDeadline(
                    this.channel.review(actionId),
                    this.responseTimeoutMs,
                );
                if (
                    latest.targetId !== review.targetId ||
                    latest.input.actionId !== actionId ||
                    latest.input.requestVersion !== requestVersion ||
                    latest.command !== preview.command ||
                    latest.taskVersion !== review.taskVersion ||
                    c.expectedVersion !== review.taskVersion ||
                    !(await withDeadline(
                        approval.allowed(),
                        this.responseTimeoutMs,
                    ))
                )
                    throw new Error(
                        '確認後に依頼版または実行場所が変わりました',
                    );
            },
        );
        if (!receipt.attemptId) throw new Error('保存された実行IDがありません');
        const value = await this.execution(receipt.attemptId);
        const a = value.attempt;
        if (
            !('command' in a) ||
            a.taskId !== this.taskId ||
            a.actionId !== actionId ||
            a.requestVersion !== requestVersion ||
            a.commandSha256 !== sha(a.command) ||
            a.command !== preview.command ||
            a.executionWhere !== 'devcontainer' ||
            value.state.status !== 'prepared'
        )
            throw new Error('準備した固定版の実行原票を取得できません');
        const context = Object.freeze({
            attempt: Object.freeze({ ...a }),
            preview,
        });
        this.issued.add(context);
        return context;
    }
    runner(ui: UiPort): RunnerPort<PreparedExecution, PreparedExecution> {
        const started = new Set<string>();
        const finished = new Map<string, ExecutionFacts>();
        const submittedOutcomes = new Map<
            string,
            Extract<RecordOperation, { type: 'execution.finished' }>['payload']
        >();
        const requireAttempt = (context: PreparedExecution) => {
            if (
                !this.issued.has(context) ||
                context.preview.command !== context.attempt.command
            )
                throw new Error('正式な確認済みcontextではありません');
            return context.attempt;
        };
        return {
            ...ui,
            allowed: async (c) => {
                if (
                    !this.issued.has(c) ||
                    !this.writable ||
                    c.preview.command !== c.attempt.command
                )
                    return false;
                const allowed = await withDeadline(
                    ui.allowed(c),
                    this.responseTimeoutMs,
                );
                return (
                    allowed &&
                    this.writable &&
                    this.issued.has(c) &&
                    c.preview.command === c.attempt.command
                );
            },
            suspend: () => {
                this.writable = false;
            },
            launch: (request) => {
                if (!this.writable)
                    throw new Error('受付停止中のため起動しません');
                return ui.launch(request);
            },
            // prepare前の全文確認を通過したcontextだけを発行する。再確認で予約を残さない。
            confirm: async () => true,
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
                    suspend: () => {
                        this.writable = false;
                    },
                    readSaved: async (sequence) => {
                        const result = await this.read({
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
                const payload: Extract<
                    RecordOperation,
                    { type: 'execution.finished' }
                >['payload'] = {
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
                        t.kind !== 'unknown' && o.uncertainStdoutBytes === 0
                            ? o.discardedStdoutBytes
                            : null,
                    missingStderrBytes:
                        t.kind !== 'unknown' && o.uncertainStderrBytes === 0
                            ? o.discardedStderrBytes
                            : null,
                };
                submittedOutcomes.set(
                    a.attemptId,
                    Object.freeze({ ...payload }),
                );
                await this.send({ type: 'execution.finished', payload });
            },
            readFinished: async (context) => {
                const a = requireAttempt(context),
                    f = finished.get(a.attemptId),
                    p = submittedOutcomes.get(a.attemptId);
                if (!f || !p)
                    throw new Error('今回の終了観測と提出値がありません');
                const saved = await this.execution(a.attemptId);
                matchAttempt(saved, a);
                const s = saved.state,
                    o = f.output;
                if (
                    !s.result ||
                    s.result.outcome !== p.outcome ||
                    s.result.exitCode !== p.exitCode ||
                    s.result.signal !== p.signal ||
                    s.observedLastSeq !== p.lastSeq ||
                    s.lastSeq !== o.lastAckSequence ||
                    s.capturedBytes !== o.savedBytes ||
                    ((p.outcome === 'unknown' || !p.complete) &&
                        s.integrity === 'complete') ||
                    (p.outcome !== 'unknown' &&
                        p.complete &&
                        s.integrity !== 'complete') ||
                    s.missingStdoutBytes !== p.missingStdoutBytes ||
                    s.missingStderrBytes !== p.missingStderrBytes
                )
                    throw new Error('終了事実と正式DBの保存結果が一致しません');
                return structuredClone(f);
            },
        };
    }
    disclosure(
        attemptId: string,
        canChange: () => Promise<boolean> = async () => false,
    ): ResultAccessAdapter<{ attemptId: string; revision: number }> {
        return {
            read: async () => {
                const value = await this.execution(attemptId),
                    d = value.state.disclosure;
                const permitted =
                    this.writable &&
                    'command' in value.attempt &&
                    (await withDeadline(canChange(), this.responseTimeoutMs));
                return {
                    context: { attemptId, revision: d.revision },
                    canChangeDisclosure: permitted && this.writable,
                    userDisplay:
                        'command' in value.attempt
                            ? '認可された本文readあり（本人の確認は別）'
                            : 'メタデータのみ。本人の本文readは未確認',
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
                const current = await this.execution(attemptId);
                if (
                    !this.writable ||
                    !('command' in current.attempt) ||
                    !(await withDeadline(canChange(), this.responseTimeoutMs))
                )
                    throw new Error('開示変更の本人権限を確認できません');
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
