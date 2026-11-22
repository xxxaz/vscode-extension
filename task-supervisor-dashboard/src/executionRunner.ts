// cspell:words noprofile norc
import {
    type CaptureLimits,
    type CapturePort,
    type CaptureSummary,
    ExecutionCapture,
    KnownNotApplied,
    type ObservedOutput,
    validateCaptureLimits,
    withDeadline,
} from './executionCapture.ts';

// このモジュールは私有のprocess portだけを持つ。共有受付型の代わりにはしない。
export interface ExecutionPreview {
    command: string;
    requestLabel: string;
    workingDirectory: string;
    documents: readonly { label: string; body: string }[];
}
export type ProcessObservation =
    | { kind: 'spawned'; processIdentity?: string; startedAt?: number }
    | { kind: 'output'; stream: ObservedOutput['stream']; bytes: Uint8Array }
    | { kind: 'lost-output'; stream: ObservedOutput['stream']; bytes: number }
    | { kind: 'closed'; code: number | null; signal: string | null };
export interface ProcessSource {
    observations: AsyncIterable<ProcessObservation>;
    // 購読だけを解放する。kill・再起動を含めない。
    [Symbol.dispose](): void;
}
export type Termination =
    | { kind: 'exit'; code: number }
    | { kind: 'signal'; signal: string }
    | { kind: 'unknown' };
export interface ExecutionFacts {
    spawnObserved: boolean;
    termination: Termination;
    output: CaptureSummary;
}
export interface RunnerPort<Context, Claim> {
    suspend?(): void;
    key(context: Context): string;
    preview(context: Context): Readonly<ExecutionPreview>;
    // UI側だけのremoteName判定ではなく正式runner登録/所属/trustも確認する。
    allowed(context: Context): Promise<boolean>;
    confirm(preview: Readonly<ExecutionPreview>): Promise<boolean>;
    // 同じkeyを再び許可しない永続ラッチ。結果不明でも解除しない。
    reserveLocalLaunch(key: string): Promise<boolean>;
    claim(context: Context): Promise<Claim>;
    claimedKey(claim: Claim): string;
    claimedPreview(claim: Claim): Readonly<ExecutionPreview>;
    launch(request: {
        executable: '/bin/bash';
        args: readonly ['--noprofile', '--norc', '-p', '-s'];
        stdin: string;
        cwd: string;
    }): ProcessSource;
    started(
        claim: Claim,
        observation: Extract<ProcessObservation, { kind: 'spawned' }>,
    ): Promise<void>;
    output(claim: Claim): CapturePort;
    finished(claim: Claim, facts: Readonly<ExecutionFacts>): Promise<void>;
    readFinished(claim: Claim): Promise<ExecutionFacts>;
    status(
        state: 'refused' | 'launching' | 'running' | 'ended' | 'unknown',
        message: string,
    ): void;
}
export type RunnerResult = {
    state: 'cancelled' | 'refused' | 'ended' | 'unknown';
    facts?: ExecutionFacts;
};

export class ExecutionRunner<Context, Claim> {
    private readonly runs = new Map<string, Promise<RunnerResult>>();
    private readonly port: RunnerPort<Context, Claim>;
    private readonly limits: CaptureLimits;
    constructor(port: RunnerPort<Context, Claim>, limits: CaptureLimits) {
        this.port = port;
        this.limits = Object.freeze({ ...limits });
        validateCaptureLimits(this.limits);
    }

    run(context: Context): Promise<RunnerResult> {
        const key = this.port.key(context);
        const existing = this.runs.get(key);
        if (existing) return existing;
        const result = Promise.resolve().then(() => this.execute(context, key));
        this.runs.set(key, result);
        void result.then((outcome) => {
            if (
                (outcome.state === 'cancelled' ||
                    outcome.state === 'refused') &&
                this.runs.get(key) === result
            )
                this.runs.delete(key);
        });
        return result;
    }
    private async bounded<T>(operation: Promise<T>): Promise<T> {
        try {
            return await withDeadline(operation, this.limits.ackTimeoutMs);
        } catch (error) {
            if (!(error instanceof KnownNotApplied)) this.port.suspend?.();
            throw error;
        }
    }

    private async execute(
        context: Context,
        key: string,
    ): Promise<RunnerResult> {
        const unknown = (): RunnerResult => {
            this.port.status(
                'unknown',
                '起動・終了の確定ができません。同じ実行を自動でやり直しません',
            );
            return { state: 'unknown' };
        };
        try {
            if (!(await this.port.allowed(context))) {
                this.port.status(
                    'refused',
                    '直接実行の受付・実行場所を確認できません',
                );
                return { state: 'refused' };
            }
            const original = this.port.preview(context);
            const preview = Object.freeze({
                ...original,
                documents: Object.freeze(
                    original.documents.map((document) =>
                        Object.freeze({ ...document }),
                    ),
                ),
            });
            if (!preview.command.trim() || !preview.workingDirectory)
                throw new Error('確認する実行本文がありません');
            if (!(await this.port.confirm(preview)))
                return { state: 'cancelled' };
            if (!(await this.port.allowed(context))) return unknown();
            if (!(await this.port.reserveLocalLaunch(key))) return unknown();
            // この地点以降はラッチを解除せず、claimの応答不明でも再実行しない。
            const claim = await this.bounded(this.port.claim(context));
            const fixed = this.port.claimedPreview(claim);
            if (
                this.port.claimedKey(claim) !== key ||
                fixed.command !== preview.command ||
                fixed.workingDirectory !== preview.workingDirectory ||
                fixed.requestLabel !== preview.requestLabel ||
                fixed.documents.length !== preview.documents.length ||
                fixed.documents.some(
                    (document, index) =>
                        document.label !== preview.documents[index].label ||
                        document.body !== preview.documents[index].body,
                ) ||
                !(await this.port.allowed(context))
            )
                return unknown();
            const capture = new ExecutionCapture(
                this.port.output(claim),
                this.limits,
            );
            let spawnObserved = false;
            let startAcknowledged = false;
            let termination: Termination = { kind: 'unknown' };
            let closed = false;
            this.port.status(
                'launching',
                '確認した固定版の本文で起動を待っています',
            );
            try {
                using child = this.port.launch({
                    executable: '/bin/bash',
                    args: ['--noprofile', '--norc', '-p', '-s'],
                    stdin: preview.command,
                    cwd: preview.workingDirectory,
                });
                for await (const observation of child.observations) {
                    if (closed) throw new Error('終了後の出力を受け取りました');
                    if (observation.kind === 'spawned') {
                        if (spawnObserved)
                            throw new Error('重複した起動観測です');
                        spawnObserved = true;
                        try {
                            await this.bounded(
                                this.port.started(claim, observation),
                            );
                            startAcknowledged = true;
                            this.port.status(
                                'running',
                                '起動とキック記録が保存されました',
                            );
                        } catch (error) {
                            capture.stopSaving(
                                error instanceof KnownNotApplied
                                    ? '開始記録が確定拒否されました。出力を全文保存できていません'
                                    : '起動事実の保存が不明です。出力を全文保存できていません',
                            );
                        }
                    } else if (observation.kind === 'lost-output') {
                        capture.lost(observation.stream, observation.bytes);
                    } else if (observation.kind === 'output') {
                        if (!spawnObserved)
                            throw new Error('起動観測前の出力です');
                        await capture.consume(
                            observation.stream,
                            observation.bytes,
                        );
                    } else {
                        closed = true;
                        if (observation.signal)
                            termination = {
                                kind: 'signal',
                                signal: observation.signal,
                            };
                        else if (
                            typeof observation.code === 'number' &&
                            Number.isSafeInteger(observation.code) &&
                            observation.code >= 0
                        )
                            termination = {
                                kind: 'exit',
                                code: observation.code,
                            };
                    }
                }
            } catch {
                termination = { kind: 'unknown' };
                capture.stopSaving(
                    'プロセスの終了を確認できません。出力の取得状態を確認してください',
                );
            }
            const facts: ExecutionFacts = {
                spawnObserved,
                termination,
                output: capture.finish(
                    closed && termination.kind !== 'unknown',
                ),
            };
            try {
                await this.bounded(this.port.finished(claim, facts));
                const saved = await this.bounded(this.port.readFinished(claim));
                const terminalMatches =
                    saved.termination.kind === termination.kind &&
                    (termination.kind === 'unknown' ||
                        (termination.kind === 'exit' &&
                            saved.termination.kind === 'exit' &&
                            saved.termination.code === termination.code) ||
                        (termination.kind === 'signal' &&
                            saved.termination.kind === 'signal' &&
                            saved.termination.signal === termination.signal));
                if (
                    saved.spawnObserved !== spawnObserved ||
                    !terminalMatches ||
                    (
                        Object.keys(facts.output) as (keyof CaptureSummary)[]
                    ).some((key) => saved.output[key] !== facts.output[key])
                )
                    throw new Error('保存した終了事実を照合できません');
            } catch {
                this.port.status(
                    'unknown',
                    '終了事実の保存結果が不明です。自動で再実行しません',
                );
                return { state: 'unknown', facts };
            }
            if (
                !spawnObserved ||
                !startAcknowledged ||
                termination.kind === 'unknown'
            ) {
                unknown();
                return { state: 'unknown', facts };
            }
            this.port.status(
                'ended',
                facts.output.status === 'complete'
                    ? 'プロセスの終了と出力が保存されました。依頼の完了は別に確認してください'
                    : 'プロセスは終了しましたが、出力は全文保存できていません',
            );
            return { state: 'ended', facts };
        } catch {
            return unknown();
        }
    }
}
