// cspell:words noprofile norc
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ObservedOutput } from '../src/executionCapture.ts';
import {
    type ExecutionFacts,
    ExecutionRunner,
    type ProcessObservation,
    type RunnerPort,
} from '../src/executionRunner.ts';

interface FixtureContext {
    key: string;
    command: string;
    requestLabel: string;
    workingDirectory: string;
    documents: readonly { label: string; body: string }[];
}
const bytes = (text: string) => new TextEncoder().encode(text);
const limits = {
    pieceBytes: 16,
    executionBytes: 128,
    inputBytes: 64,
    maxPieces: 32,
    ackTimeoutMs: 25,
};
const closed: ProcessObservation = { kind: 'closed', code: 0, signal: null };
function fixture(
    events: ProcessObservation[] = [
        { kind: 'spawned' },
        { kind: 'output', stream: 'stdout', bytes: bytes('確認\n') },
        closed,
    ],
) {
    const context: FixtureContext = {
        key: '検証用の実行1',
        command: '  printf "%s\\n" "確認"\n',
        requestLabel: '検証依頼・固定版1',
        workingDirectory: '/検証用workspace',
        documents: [
            { label: '資料・固定版1', body: '  資料の全文\n確認条件\n' },
        ],
    };
    const claimed = { ...context };
    const reserved = new Set<string>(),
        calls: string[] = [],
        stored = new Map<number, ObservedOutput>(),
        shown: ObservedOutput[] = [];
    const launched: Parameters<
        RunnerPort<FixtureContext, FixtureContext>['launch']
    >[0][] = [];
    const reports: ExecutionFacts[] = [];
    let saved: ExecutionFacts | undefined;
    const port: RunnerPort<FixtureContext, FixtureContext> = {
        key: (c) => c.key,
        preview: (c) => c,
        allowed: async () => true,
        confirm: async () => true,
        reserveLocalLaunch: async (key) => {
            if (reserved.has(key)) return false;
            reserved.add(key);
            return true;
        },
        claim: async () => {
            calls.push('claim');
            return claimed;
        },
        claimedKey: (c) => c.key,
        claimedPreview: (c) => c,
        launch: (request) => {
            calls.push('launch');
            launched.push(request);
            return {
                observations: (async function* () {
                    for (const e of events) yield e;
                })(),
                [Symbol.dispose]() {
                    calls.push('dispose');
                },
            };
        },
        started: async () => {
            calls.push('started');
        },
        output: () => ({
            append: async (p) => {
                calls.push(`save${p.sequence}`);
                stored.set(p.sequence, { ...p });
                return p.sequence;
            },
            readSaved: async (seq) => {
                calls.push(`read${seq}`);
                const p = stored.get(seq);
                assert.ok(p);
                return p;
            },
            showSaved: (p) => {
                calls.push(`show${p.sequence}`);
                shown.push({ ...p });
            },
            warning: () => {
                calls.push('warning');
            },
        }),
        finished: async (_c, facts) => {
            calls.push('finished');
            reports.push(facts);
            saved = structuredClone(facts);
        },
        readFinished: async () => {
            calls.push('readFinished');
            assert.ok(saved);
            return saved;
        },
        status: (state, message) => {
            calls.push(`status:${state}`);
            assert.ok(message);
        },
    };
    return {
        context,
        claimed,
        port,
        calls,
        reserved,
        launched,
        reports,
        shown,
        runner: () => new ExecutionRunner(port, limits),
    };
}
test('本人の明示確認後に固定本文をBash stdinへ渡し、spawnの保存とack後readを待つ', async () => {
    const f = fixture();
    let confirmed = '';
    f.port.confirm = async (p) => {
        confirmed = p.command;
        return true;
    };
    const result = await f.runner().run(f.context);
    assert.equal(result.state, 'ended');
    assert.deepEqual(f.launched, [
        {
            executable: '/bin/bash',
            args: ['--noprofile', '--norc', '-p', '-s'],
            stdin: confirmed,
            cwd: f.context.workingDirectory,
        },
    ]);
    assert.equal(confirmed, f.claimed.command);
    assert.deepEqual(result.facts?.termination, { kind: 'exit', code: 0 });
    assert.ok(f.calls.indexOf('started') < f.calls.indexOf('save1'));
    assert.ok(f.calls.indexOf('finished') < f.calls.indexOf('readFinished'));
    assert.ok(
        f.calls.indexOf('readFinished') < f.calls.indexOf('status:ended'),
    );
    assert.equal(f.shown[0].text, '確認\n');
});
test('同時押下・終了後・runner再作成でも同attemptを二度起動しない', async () => {
    const f = fixture(),
        runner = f.runner();
    const first = runner.run(f.context);
    assert.equal(runner.run(f.context), first);
    await first;
    assert.equal(runner.run(f.context), first);
    assert.equal((await f.runner().run(f.context)).state, 'unknown');
    assert.equal(f.launched.length, 1);
    assert.equal(f.calls.filter((c) => c === 'claim').length, 1);
});
test('資料全文も固定版で確認し、claimが別資料を返した場合は起動しない', async () => {
    const f = fixture();
    let confirmed = '';
    f.port.confirm = async (preview) => {
        confirmed = preview.documents[0].body;
        return true;
    };
    f.port.claim = async () => ({
        ...f.claimed,
        documents: [{ label: '資料・固定版2', body: '変更後の資料' }],
    });
    assert.equal((await f.runner().run(f.context)).state, 'unknown');
    assert.equal(confirmed, f.context.documents[0].body);
    assert.equal(f.launched.length, 0);
});
test('上限が不正ならclaim前に拒否する', () => {
    const f = fixture();
    for (const change of [
        { pieceBytes: 3 },
        { ackTimeoutMs: 0 },
        { inputBytes: 1 },
        { executionBytes: NaN },
    ])
        assert.throws(
            () => new ExecutionRunner(f.port, { ...limits, ...change }),
            /必要/,
        );
    assert.equal(f.launched.length, 0);
    assert.deepEqual(f.calls, []);
});
test('所在未確認と取消はclaim・launchに到達せず、未接続を実行可能にしない', async () => {
    const refused = fixture();
    refused.port.allowed = async () => false;
    assert.equal(
        (await refused.runner().run(refused.context)).state,
        'refused',
    );
    const cancelled = fixture();
    cancelled.port.confirm = async () => false;
    assert.equal(
        (await cancelled.runner().run(cancelled.context)).state,
        'cancelled',
    );
    assert.deepEqual(refused.launched, []);
    assert.deepEqual(cancelled.launched, []);
    assert.ok(
        !refused.calls.includes('claim') && !cancelled.calls.includes('claim'),
    );
});
test('確認した本文/版とclaim内容が違う場合は起動せず、予約ラッチを残す', async () => {
    for (const changed of [
        { command: '変更された本文' },
        { requestLabel: '新しい版' },
        { workingDirectory: '/別workspace' },
        { key: '別の実行' },
    ]) {
        const f = fixture();
        Object.assign(f.claimed, changed);
        assert.equal((await f.runner().run(f.context)).state, 'unknown');
        assert.deepEqual(f.launched, []);
        assert.ok(f.reserved.has(f.context.key));
    }
});
test('claim前の取消だけは明示確認からやり直せるが、起動は一度だけ', async () => {
    const f = fixture(),
        runner = f.runner();
    f.port.confirm = async () => false;
    assert.equal((await runner.run(f.context)).state, 'cancelled');
    assert.equal(f.reserved.size, 0);
    f.port.confirm = async () => true;
    assert.equal((await runner.run(f.context)).state, 'ended');
    assert.equal(f.launched.length, 1);
});
test('claim後の現在依頼の編集で承認済み旧版本文を差し替えない', async () => {
    const f = fixture();
    f.port.claim = async () => {
        f.context.command = '現在の新しい本文';
        return f.claimed;
    };
    assert.equal((await f.runner().run(f.context)).state, 'ended');
    assert.equal(f.launched[0].stdin, f.claimed.command);
    assert.notEqual(f.launched[0].stdin, f.context.command);
});
test('claim応答不明とclaim後の所在喪失では起動せず自動再実行しない', async () => {
    const f = fixture();
    f.port.claim = () => new Promise(() => {});
    const runner = f.runner();
    const result = runner.run(f.context);
    assert.equal((await result).state, 'unknown');
    assert.equal(runner.run(f.context), result);
    assert.equal(f.launched.length, 0);
    const lost = fixture();
    let calls = 0;
    lost.port.allowed = async () => ++calls < 3;
    assert.equal((await lost.runner().run(lost.context)).state, 'unknown');
    assert.equal(lost.launched.length, 0);
});
test('spawn未観測やwrapperのexit0だけを本人起動済みと扱わない', async () => {
    const f = fixture([closed]);
    const result = await f.runner().run(f.context);
    assert.equal(result.state, 'unknown');
    assert.equal(result.facts?.spawnObserved, false);
    assert.ok(!f.calls.includes('started'));
});
test('spawn開始保存の失敗はunknownにし、後続出力はdrainして欠落を残す', async () => {
    const f = fixture();
    f.port.started = async () => {
        throw Error('保存不可');
    };
    const result = await f.runner().run(f.context);
    assert.equal(result.state, 'unknown');
    assert.equal(result.facts?.output.status, 'incomplete');
    assert.equal(f.shown.length, 0);
    assert.ok(!f.calls.includes('save1'));
});
test('close不明・signal・非0終了を区別し、U完了を呼ぶportを持たない', async () => {
    const lost = fixture([{ kind: 'spawned' }]);
    const lostResult = await lost.runner().run(lost.context);
    assert.equal(lostResult.state, 'unknown');
    assert.equal(lostResult.facts?.output.status, 'unknown');
    for (const terminal of [
        { kind: 'closed', code: 2, signal: null },
        { kind: 'closed', code: null, signal: 'SIGTERM' },
    ] as const) {
        const f = fixture([{ kind: 'spawned' }, terminal]);
        const result = await f.runner().run(f.context);
        assert.equal(result.state, 'ended');
        assert.deepEqual(
            result.facts?.termination,
            terminal.signal
                ? { kind: 'signal', signal: 'SIGTERM' }
                : { kind: 'exit', code: 2 },
        );
        assert.ok(!f.calls.some((c) => c === 'done'));
    }
});
test('launch失敗・終了保存失敗・終了read失敗でも再起動しない', async () => {
    for (const stage of ['launch', 'finished', 'readFinished'] as const) {
        const f = fixture();
        f.port[stage] = () => {
            throw Error('検証用失敗');
        };
        const runner = f.runner();
        const result = runner.run(f.context);
        assert.equal((await result).state, 'unknown');
        assert.equal(runner.run(f.context), result);
        assert.ok(f.launched.length <= 1);
    }
});
