import { createHash } from 'node:crypto';

// runner内の観測値。正式な受付・DBのwire型ではない。
export interface ObservedOutput {
    sequence: number;
    stream: 'stdout' | 'stderr';
    text: string;
    byteLength: number;
    sha256: string;
}
export interface CaptureLimits {
    pieceBytes: number;
    executionBytes: number;
    inputBytes: number;
    maxPieces: number;
    ackTimeoutMs: number;
}
export interface CaptureSummary {
    observedBytes: number;
    savedBytes: number;
    discardedBytes: number;
    uncertainBytes: number;
    discardedStdoutBytes: number;
    discardedStderrBytes: number;
    uncertainStdoutBytes: number;
    uncertainStderrBytes: number;
    lastSubmittedSequence: number;
    lastAckSequence: number;
    status: 'complete' | 'incomplete' | 'unknown';
    decodingIncomplete: boolean;
    displayUnavailable: boolean;
}
export interface CapturePort {
    append(part: Readonly<ObservedOutput>): Promise<number>;
    readSaved(sequence: number): Promise<ObservedOutput>;
    showSaved(part: Readonly<ObservedOutput>): void;
    warning(message: string): void;
}

// 正式受付が未保存を確定した場合。応答不明とは区別する。
export class OutputNotStored extends Error {}

export function validateCaptureLimits(limits: CaptureLimits): void {
    for (const value of Object.values(limits))
        if (!Number.isSafeInteger(value) || value <= 0)
            throw new Error('出力上限と待機時間は正の整数が必要です');
    if (limits.pieceBytes < 4 || limits.inputBytes < limits.pieceBytes)
        throw new Error('UTF-8文字と出力片を保持できる上限が必要です');
}

export async function withDeadline<T>(
    operation: Promise<T>,
    milliseconds: number,
): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    using _cleanup = {
        [Symbol.dispose]() {
            if (timer) clearTimeout(timer);
        },
    };
    return await Promise.race([
        operation,
        new Promise<never>((_, reject) => {
            timer = setTimeout(
                () => reject(new Error('保存・照会の応答を確認できません')),
                milliseconds,
            );
        }),
    ]);
}

function incompleteTail(bytes: Uint8Array): number {
    for (let i = bytes.length - 1; i >= Math.max(0, bytes.length - 4); i--) {
        const b = bytes[i];
        if ((b & 0xc0) === 0x80) continue;
        const width =
            b >= 0xc2 && b <= 0xdf
                ? 2
                : b >= 0xe0 && b <= 0xef
                  ? 3
                  : b >= 0xf0 && b <= 0xf4
                    ? 4
                    : 1;
        return bytes.length - i < width ? bytes.length - i : 0;
    }
    return 0;
}

function* pieces(text: string, maximum: number) {
    let start = 0,
        offset = 0,
        size = 0;
    for (const character of text) {
        const point = character.codePointAt(0);
        if (point === undefined) throw new Error('UTF-8文字を確認できません');
        const length =
            point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
        if (size + length > maximum) {
            yield text.slice(start, offset);
            start = offset;
            size = 0;
        }
        size += length;
        offset += character.length;
    }
    if (offset > start) yield text.slice(start);
}

export class ExecutionCapture {
    private readonly pending = {
        stdout: new Uint8Array(),
        stderr: new Uint8Array(),
    };
    private draining = false;
    private busy = false;
    private closed = false;
    private sourceComplete = true;
    private submittedBytes = 0;
    private readonly facts = {
        observedBytes: 0,
        savedBytes: 0,
        discardedBytes: 0,
        uncertainBytes: 0,
        discardedStdoutBytes: 0,
        discardedStderrBytes: 0,
        uncertainStdoutBytes: 0,
        uncertainStderrBytes: 0,
        lastSubmittedSequence: 0,
        lastAckSequence: 0,
        decodingIncomplete: false,
        displayUnavailable: false,
    };
    private readonly port: CapturePort;
    private readonly limits: CaptureLimits;
    constructor(port: CapturePort, limits: CaptureLimits) {
        this.port = port;
        this.limits = Object.freeze({ ...limits });
        validateCaptureLimits(this.limits);
    }
    stopSaving(message: string) {
        this.draining = true;
        this.port.warning(message);
    }
    lost(stream: ObservedOutput['stream'], bytes: number) {
        if (
            !Number.isSafeInteger(bytes) ||
            bytes < 0 ||
            this.closed ||
            this.busy
        )
            throw new Error('欠落byteの観測が不正です');
        this.facts.observedBytes += bytes;
        this.discard(stream, bytes);
        this.stopSaving('捕捉待ちの上限を超え、出力を全文保存できていません');
    }
    private discard(stream: ObservedOutput['stream'], bytes: number) {
        this.facts.discardedBytes += bytes;
        this.facts[
            stream === 'stdout'
                ? 'discardedStdoutBytes'
                : 'discardedStderrBytes'
        ] += bytes;
    }
    async consume(
        stream: ObservedOutput['stream'],
        bytes: Uint8Array,
    ): Promise<void> {
        if (this.closed || this.busy)
            throw new Error('出力は観測順に1片ずつ渡してください');
        this.facts.observedBytes += bytes.byteLength;
        if (this.draining || bytes.byteLength > this.limits.inputBytes) {
            this.discard(stream, bytes.byteLength);
            if (!this.draining)
                this.stopSaving('捕捉上限を超え、出力を全文保存できていません');
            return;
        }
        this.busy = true;
        using _cleanup = {
            [Symbol.dispose]: () => {
                this.busy = false;
            },
        };
        // 入力1片と最大3byteのUTF-8境界だけを保持する。待ち行列を増やさない。
        const combined = new Uint8Array(
            this.pending[stream].length + bytes.length,
        );
        combined.set(this.pending[stream]);
        combined.set(bytes, this.pending[stream].length);
        const tail = incompleteTail(combined);
        let text: string;
        try {
            text = new TextDecoder('utf-8', {
                fatal: true,
                ignoreBOM: true,
            }).decode(combined.subarray(0, combined.length - tail));
        } catch {
            this.pending[stream] = new Uint8Array();
            this.discard(stream, combined.length);
            this.facts.decodingIncomplete = true;
            this.stopSaving(
                '不正なUTF-8を捕捉し、原文を全文保存できていません',
            );
            return;
        }
        this.pending[stream] = combined.slice(combined.length - tail);
        for (const body of pieces(text, this.limits.pieceBytes)) {
            const encoded = new TextEncoder().encode(body);
            if (
                this.draining ||
                this.facts.lastSubmittedSequence >= this.limits.maxPieces ||
                this.submittedBytes + encoded.length >
                    this.limits.executionBytes
            ) {
                this.discard(stream, encoded.length);
                if (!this.draining)
                    this.stopSaving(
                        '実行の保存上限に達し、出力を全文保存できていません',
                    );
                continue;
            }
            const part = Object.freeze({
                sequence: ++this.facts.lastSubmittedSequence,
                stream,
                text: body,
                byteLength: encoded.length,
                sha256: createHash('sha256').update(encoded).digest('hex'),
            });
            this.submittedBytes += part.byteLength;
            try {
                const ack = await withDeadline(
                    this.port.append(part),
                    this.limits.ackTimeoutMs,
                );
                if (ack !== part.sequence)
                    throw new Error('保存位置が一致しません');
            } catch (error) {
                if (error instanceof OutputNotStored)
                    this.discard(stream, part.byteLength);
                else {
                    this.facts.uncertainBytes += part.byteLength;
                    this.facts[
                        stream === 'stdout'
                            ? 'uncertainStdoutBytes'
                            : 'uncertainStderrBytes'
                    ] += part.byteLength;
                }
                this.stopSaving(
                    'DBへの保存結果が不明です。以後の出力は全文保存できません',
                );
                continue;
            }
            this.facts.savedBytes += part.byteLength;
            this.facts.lastAckSequence = part.sequence;
            try {
                const saved = await withDeadline(
                    this.port.readSaved(part.sequence),
                    this.limits.ackTimeoutMs,
                );
                if (
                    saved.sequence !== part.sequence ||
                    saved.stream !== part.stream ||
                    saved.text !== part.text ||
                    saved.byteLength !== part.byteLength ||
                    saved.sha256 !== part.sha256
                )
                    throw new Error('保存済み出力の照合が一致しません');
                this.port.showSaved(Object.freeze({ ...saved }));
            } catch {
                this.facts.displayUnavailable = true;
                this.port.warning(
                    '保存済み出力の表示を取得できません。前回の表示を保持してください',
                );
            }
        }
    }
    finish(sourceComplete = true): CaptureSummary {
        if (this.busy) throw new Error('未確定の出力があります');
        if (!this.closed) {
            this.sourceComplete = sourceComplete;
            for (const stream of ['stdout', 'stderr'] as const) {
                const remaining = this.pending[stream].length;
                this.discard(stream, remaining);
                if (remaining) this.facts.decodingIncomplete = true;
                this.pending[stream] = new Uint8Array();
            }
            this.closed = true;
        }
        return {
            ...this.facts,
            status:
                this.facts.discardedBytes || this.facts.decodingIncomplete
                    ? 'incomplete'
                    : this.facts.uncertainBytes || !this.sourceComplete
                      ? 'unknown'
                      : 'complete',
        };
    }
}
