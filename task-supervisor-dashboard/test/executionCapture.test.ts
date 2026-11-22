import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    type CaptureLimits,
    type CapturePort,
    ExecutionCapture,
    type ObservedOutput,
} from '../src/executionCapture.ts';

const bytes = (text: string) => new TextEncoder().encode(text);
const limits: CaptureLimits = {
    pieceBytes: 16,
    executionBytes: 128,
    inputBytes: 64,
    maxPieces: 32,
    ackTimeoutMs: 50,
};
test('読戻しが未完了でも照会を積み上げず、後続のDB保存byteは保持する', async () => {
    let reads = 0;
    const f = fixture(
        {
            readSaved: () => {
                reads++;
                return new Promise(() => {});
            },
        },
        { pieceBytes: 4, ackTimeoutMs: 5 },
    );
    await f.capture.consume('stdout', bytes('abcdefghijkl'));
    const result = f.capture.finish();
    assert.equal(reads, 1);
    assert.equal(result.savedBytes, 12);
    assert.equal(result.status, 'complete');
    assert.equal(result.displayUnavailable, true);
    assert.equal(f.shown.length, 0);
});
function fixture(
    extra: Partial<CapturePort> = {},
    overrides: Partial<CaptureLimits> = {},
) {
    const stored = new Map<number, ObservedOutput>();
    const shown: ObservedOutput[] = [],
        calls: string[] = [],
        warnings: string[] = [];
    const port: CapturePort = {
        append: async (part) => {
            calls.push(`save${part.sequence}`);
            stored.set(part.sequence, { ...part });
            return part.sequence;
        },
        readSaved: async (seq) => {
            calls.push(`read${seq}`);
            const part = stored.get(seq);
            assert.ok(part);
            return part;
        },
        showSaved: (part) => {
            calls.push(`show${part.sequence}`);
            shown.push({ ...part });
        },
        warning: (message) => {
            warnings.push(message);
        },
        ...extra,
    };
    return {
        capture: new ExecutionCapture(port, { ...limits, ...overrides }),
        stored,
        shown,
        calls,
        warnings,
        port,
    };
}
test('stream別のUTF8境界を保持し、確定した出力片の共通seqでack後readを表示する', async () => {
    const f = fixture();
    const emoji = bytes('😀');
    await f.capture.consume('stdout', emoji.subarray(0, 2));
    await f.capture.consume('stderr', bytes('注意\n'));
    await f.capture.consume('stdout', emoji.subarray(2));
    assert.deepEqual(
        f.shown.map((p) => [p.sequence, p.stream, p.text]),
        [
            [1, 'stderr', '注意\n'],
            [2, 'stdout', '😀'],
        ],
    );
    assert.deepEqual(f.calls, [
        'save1',
        'read1',
        'show1',
        'save2',
        'read2',
        'show2',
    ]);
    const end = f.capture.finish();
    assert.equal(end.status, 'complete');
    assert.equal(end.observedBytes, end.savedBytes);
    assert.equal(end.discardedBytes, 0);
});
test('16KiBのUTF8片へ分割しJSON制御文字escape後も256KiB枠を超えない', async () => {
    const f = fixture(
        {},
        {
            pieceBytes: 16 * 1024,
            executionBytes: 8 * 1024 * 1024,
            inputBytes: 64 * 1024,
        },
    );
    const raw = `${'\0'.repeat(16 * 1024)}日本語😀`;
    await f.capture.consume('stdout', bytes(raw));
    assert.equal(f.shown.map((p) => p.text).join(''), raw);
    assert.ok(f.shown.every((p) => p.byteLength <= 16 * 1024));
    assert.ok(
        f.shown.every(
            (p) => bytes(JSON.stringify({ payload: p })).length < 256 * 1024,
        ),
    );
    assert.equal(f.capture.finish().status, 'complete');
});
test('BOMと前後空白は保存し、制御文字を通常のHTMLとして解釈しない', async () => {
    const f = fixture({}, { executionBytes: 256 });
    const raw = '\ufeff  <script>確認</script>\t\n';
    await f.capture.consume('stdout', bytes(raw));
    assert.equal(f.shown.map((p) => p.text).join(''), raw);
    assert.equal(f.capture.finish().savedBytes, bytes(raw).length);
});
test('不正UTF8と切れた末尾を置換して完全保存とせず、欠落byteへ含める', async () => {
    for (const raw of [
        new Uint8Array([0xff, 0x41]),
        bytes('😀').subarray(0, 2),
    ]) {
        const f = fixture();
        await f.capture.consume('stdout', raw);
        const end = f.capture.finish();
        assert.equal(end.status, 'incomplete');
        assert.equal(end.decodingIncomplete, true);
        assert.equal(end.discardedBytes, raw.length);
        assert.deepEqual(f.shown, []);
    }
});
test('実行上限の境界は保存し、超過分をdrainして全文欠落を明示する', async () => {
    const f = fixture({}, { pieceBytes: 4, executionBytes: 8 });
    await f.capture.consume('stdout', bytes('abcdefgh'));
    await f.capture.consume('stderr', bytes('追加'));
    const end = f.capture.finish();
    assert.equal(end.savedBytes, 8);
    assert.equal(end.discardedBytes, 6);
    assert.equal(end.status, 'incomplete');
    assert.equal(f.shown.map((p) => p.text).join(''), 'abcdefgh');
    assert.match(f.warnings.join('\n'), /全文保存/);
});
test('遅延ackより前に保存済み表示せず、timeout後のackで表示を再開しない', async () => {
    let resolveAck: (seq: number) => void = () => {
        throw Error('未開始');
    };
    const f = fixture(
        {
            append: () =>
                new Promise((resolve) => {
                    resolveAck = resolve;
                }),
        },
        { ackTimeoutMs: 10 },
    );
    const pending = f.capture.consume('stdout', bytes('abc'));
    assert.deepEqual(f.shown, []);
    await pending;
    resolveAck(1);
    await f.capture.consume('stderr', bytes('de'));
    const end = f.capture.finish();
    assert.equal(end.uncertainBytes, 3);
    assert.equal(end.discardedBytes, 2);
    assert.equal(end.status, 'incomplete');
    assert.deepEqual(f.shown, []);
});
test('不一致ackは不明とし、read失敗は保存byteを失敗表示と分ける', async () => {
    const bad = fixture({ append: async () => 99 });
    await bad.capture.consume('stdout', bytes('abc'));
    assert.equal(bad.capture.finish().status, 'unknown');
    assert.deepEqual(bad.shown, []);
    const f = fixture({
        readSaved: async () => {
            throw Error('読取不可');
        },
    });
    await f.capture.consume('stdout', bytes('abc'));
    const end = f.capture.finish();
    assert.equal(end.status, 'complete');
    assert.equal(end.savedBytes, 3);
    assert.equal(end.displayUnavailable, true);
    assert.deepEqual(f.shown, []);
});
test('入力バッファ超過と並行consumeは有界条件で拒否し、出力を増やして保持しない', async () => {
    const large = fixture();
    await large.capture.consume('stdout', new Uint8Array(65));
    assert.equal(large.capture.finish().discardedBytes, 65);
    let resolveAck: (seq: number) => void = () => {
        throw Error('未開始');
    };
    const f = fixture({
        append: () =>
            new Promise((resolve) => {
                resolveAck = resolve;
            }),
    });
    const pending = f.capture.consume('stdout', bytes('a'));
    await assert.rejects(f.capture.consume('stderr', bytes('b')), /観測順/);
    resolveAck(1);
    await pending;
    assert.equal(f.capture.finish().observedBytes, 1);
});
test('小片が多い場合も件数上限でDB受付回数を抑え、残りは欠落としてdrainする', async () => {
    const f = fixture({}, { maxPieces: 4 });
    for (let i = 0; i < 8; i++) await f.capture.consume('stdout', bytes('a'));
    const end = f.capture.finish();
    assert.equal(f.stored.size, 4);
    assert.equal(end.savedBytes, 4);
    assert.equal(end.discardedBytes, 4);
    assert.equal(end.status, 'incomplete');
});
