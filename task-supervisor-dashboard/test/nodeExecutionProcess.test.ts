// cspell:words noprofile norc
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { nodeExecutionProcess } from '../src/nodeExecutionProcess.ts';

const request = (stdin: string, cwd = process.cwd()) => ({
    executable: '/bin/bash' as const,
    args: ['--noprofile', '--norc', '-p', '-s'] as const,
    stdin,
    cwd,
});
test('同時in-flightの両stream合計128KiBを保ち、超過byteをstream別に報告する', async () => {
    class Child extends EventEmitter {
        pid = 123;
        stdin = new PassThrough();
        stdout = new PassThrough();
        stderr = new PassThrough();
    }
    const child = new Child();
    using source = nodeExecutionProcess(
        request('printf fixture'),
        () => true,
        () => child,
    );
    child.emit('spawn');
    // pause済みでも両streamの到着済みcallbackが残る最悪条件を与える。
    child.stdout.emit('data', Buffer.alloc(64 * 1024, 65));
    child.stderr.emit('data', Buffer.alloc(64 * 1024, 66));
    child.stdout.emit('data', Buffer.alloc(3, 67));
    child.stderr.emit('data', Buffer.alloc(5, 68));
    child.emit('close', 0, null);
    const events = [];
    for await (const event of source.observations) events.push(event);
    assert.equal(events[0].kind, 'spawned');
    assert.equal(
        events
            .filter((e) => e.kind === 'output')
            .reduce(
                (sum, e) => sum + (e.kind === 'output' ? e.bytes.length : 0),
                0,
            ),
        128 * 1024,
    );
    assert.deepEqual(
        events.filter((e) => e.kind === 'lost-output'),
        [
            { kind: 'lost-output', stream: 'stdout', bytes: 3 },
            { kind: 'lost-output', stream: 'stderr', bytes: 5 },
        ],
    );
    assert.deepEqual(events.at(-1), { kind: 'closed', code: 0, signal: null });
    assert.equal(child.stdin.read().toString(), 'printf fixture');
});
test('実Bashはstdinの全文を実行しspawn・stdout/stderr・終了値を観測する', async () => {
    using source = nodeExecutionProcess(
        request(
            "printf '%s' '日本語 $HOME'\nprintf '%s' 'エラー原文' >&2\nexit 7\n",
        ),
        () => true,
    );
    let out = '',
        err = '',
        spawned = false,
        closed = false;
    for await (const e of source.observations) {
        if (e.kind === 'spawned') {
            spawned = true;
            assert.ok(e.processIdentity);
            assert.ok(e.startedAt);
        } else if (e.kind === 'output') {
            assert.equal(spawned, true);
            if (e.stream === 'stdout') out += Buffer.from(e.bytes).toString();
            else err += Buffer.from(e.bytes).toString();
        } else if (e.kind === 'closed') {
            closed = true;
            assert.equal(e.code, 7);
            assert.equal(e.signal, null);
        } else assert.fail('少量の出力で欠落した');
    }
    assert.equal(out, '日本語 $HOME');
    assert.equal(err, 'エラー原文');
    assert.equal(closed, true);
});
test('所在未確認ではspawnしない。存在しないcwdの起動失敗をexit0にしない', async () => {
    assert.throws(
        () => nodeExecutionProcess(request('exit 0'), () => false),
        /実行場所/,
    );
    using source = nodeExecutionProcess(
        request('exit 0', '/T341-nonexistent-cwd'),
        () => true,
    );
    const events = [];
    for await (const e of source.observations) events.push(e);
    assert.deepEqual(events, [{ kind: 'closed', code: null, signal: null }]);
});
test('DB待ちに相当する遅延でもstreamを抑制し有界で読み、全出力を排出する', async () => {
    using source = nodeExecutionProcess(
        request("head -c 262144 /dev/zero | tr '\\0' x\nprintf end >&2\n"),
        () => true,
    );
    let count = 0,
        err = '';
    for await (const e of source.observations) {
        if (e.kind === 'output') {
            assert.ok(e.bytes.length <= 128 * 1024);
            if (e.stream === 'stdout') count += e.bytes.length;
            else err += Buffer.from(e.bytes).toString();
            await new Promise((resolve) => setTimeout(resolve, 2));
        } else if (e.kind === 'lost-output')
            assert.fail('通常のpipe抑制で欠落した');
    }
    assert.equal(count, 262144);
    assert.equal(err, 'end');
});
