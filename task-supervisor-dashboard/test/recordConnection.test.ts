import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import type {
    ExecutionAttempt,
    ExecutionReadResult,
    RecordCommand,
    RecordRead,
    RecordReadResult,
    RecordResult,
} from '../src/contracts/records.ts';
import { ExecutionCapture, OutputNotStored } from '../src/executionCapture.ts';
import {
    type RecordChannel,
    RecordConnection,
    recordCaptureLimits,
} from '../src/recordConnection.ts';

const command = "printf '原文\\n'";
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
function fixture() {
    const attempt: ExecutionAttempt = {
        schemaVersion: 1,
        attemptId: 'attempt-1',
        taskId: 'T1',
        actionId: 'U1',
        requestVersion: 'request-version',
        command,
        commandSha256: sha(command),
        executionWhere: 'devcontainer',
        confirmedBy: 'person',
        runnerId: 'runner',
        policyRef: 'fixture-only',
        createdAt: 1,
    };
    const value: ExecutionReadResult = {
        attempt,
        state: {
            schemaVersion: 1,
            attemptId: attempt.attemptId,
            status: 'prepared',
            claimedAt: null,
            startedAt: null,
            processIdentity: null,
            lastSeq: 0,
            capturedBytes: 0,
            encodedBytes: 0,
            reservedBytes: 0,
            limited: false,
            integrity: 'unknown',
            endedAt: null,
            result: null,
            observedLastSeq: null,
            missingStdoutBytes: null,
            missingStderrBytes: null,
            disclosure: {
                revision: 0,
                allow: false,
                changedBy: null,
                changedAt: null,
            },
        },
    };
    let version = 10,
        submit:
            | ((c: RecordCommand) => RecordResult | Promise<RecordResult>)
            | undefined;
    const commands: RecordCommand[] = [];
    const channel: RecordChannel = {
        async submit(c) {
            commands.push(structuredClone(c));
            assert.equal(c.expectedVersion, version);
            const record = submit
                ? await submit(c)
                : { attemptId: attempt.attemptId };
            return { record, taskVersion: ++version };
        },
        async read<Q extends RecordRead>(
            q: Q,
        ): Promise<RecordReadResult<Q['type']>> {
            assert.equal(q.targetId, 'T1');
            if (q.type !== 'execution.read')
                throw new Error('このfixtureのread対象外です');
            return structuredClone(value) as RecordReadResult<Q['type']>;
        },
    };
    const connection = new RecordConnection(
        channel,
        'T1',
        version,
        'UIの自己申告は認可ではない',
    );
    const shown: string[] = [],
        warnings: string[] = [];
    const ui = {
        allowed: async () => false,
        confirm: async () => false,
        reserveLocalLaunch: async () => false,
        launch: () => {
            throw new Error('unitで実行しない');
        },
        status: () => {},
        showSaved: (p: { text: string }) => shown.push(p.text),
        warning: (s: string) => warnings.push(s),
    };
    return {
        attempt,
        value,
        commands,
        connection,
        ui,
        shown,
        warnings,
        setSubmit: (fn: typeof submit) => {
            submit = fn;
        },
    };
}
test('正式な固定実行原票を読み、表示版ではなく保存後のタスク版を次の操作に渡す', async () => {
    const f = fixture();
    const c = await f.connection.prepare('U1', 'request-version', '/workspace');
    assert.equal(c.preview.command, command);
    assert.equal(Object.isFrozen(c.attempt), true);
    const port = f.connection.runner(f.ui);
    f.setSubmit(() => {
        f.value.state.status = 'launching';
        return { status: 'launching' };
    });
    assert.equal(await port.claim(c), c);
    assert.deepEqual(
        f.commands.map((c) => c.expectedVersion),
        [10, 11],
    );
});
test('task版の競合や応答不明の後は新しい版への差替えも同IDの自動再送もしない', async () => {
    const f = fixture();
    f.setSubmit(() => {
        throw new Error('version-conflict');
    });
    await assert.rejects(
        f.connection.prepare('U1', 'request-version', '/workspace'),
    );
    await assert.rejects(
        f.connection.prepare('U1', 'request-version', '/workspace'),
    );
    assert.equal(f.commands.length, 1);
});
test('固定本文の欠落・hash違い・所属違いを現在の依頼で補わない', async () => {
    for (const change of [
        (f: ReturnType<typeof fixture>) => {
            Reflect.deleteProperty(f.value.attempt, 'command');
        },
        (f: ReturnType<typeof fixture>) => {
            f.attempt.command = '別の本文';
        },
        (f: ReturnType<typeof fixture>) => {
            f.attempt.taskId = 'T2';
        },
    ]) {
        const f = fixture();
        change(f);
        await assert.rejects(
            f.connection.prepare('U1', 'request-version', '/workspace'),
        );
    }
});
test('appliedだけのackを保存済みにせず、stored=false/drain=trueは確定した欠落として数える', async () => {
    for (const rejected of [false, true]) {
        const f = fixture(),
            c = await f.connection.prepare(
                'U1',
                'request-version',
                '/workspace',
            );
        f.setSubmit(() =>
            rejected ? { stored: false, drain: true } : { seq: 1 },
        );
        const capture = new ExecutionCapture(
            f.connection.runner(f.ui).output(c),
            recordCaptureLimits,
        );
        await capture.consume('stderr', new TextEncoder().encode('原文'));
        const facts = capture.finish();
        assert.equal(facts.savedBytes, 0);
        assert.equal(f.shown.length, 0);
        if (rejected) {
            assert.equal(facts.discardedStderrBytes, 6);
            assert.equal(facts.uncertainStderrBytes, 0);
        } else {
            assert.equal(facts.uncertainStderrBytes, 6);
            assert.equal(facts.discardedStderrBytes, 0);
        }
    }
});
test('stream別の不正UTF8・末尾欠落・不明ackを正式終了値に渡せる形で保持する', async () => {
    const capture = new ExecutionCapture(
        {
            append: async () => {
                throw new OutputNotStored('未保存');
            },
            readSaved: async () => {
                throw Error('未保存を表示しない');
            },
            showSaved: () => assert.fail(),
            warning: () => {},
        },
        recordCaptureLimits,
    );
    await capture.consume('stdout', new TextEncoder().encode('A'));
    await capture.consume('stderr', new Uint8Array([0xff, 0xfe]));
    const result = capture.finish();
    assert.equal(result.discardedStdoutBytes, 1);
    assert.equal(result.discardedStderrBytes, 2);
    assert.equal(result.discardedBytes, 3);
    assert.equal(result.status, 'incomplete');
});
test('開示変更は実行前も終了後も版を照合し、保存後の正式readで確認する', async () => {
    const f = fixture();
    const access = f.connection.disclosure(f.attempt.attemptId);
    f.setSubmit((c) => {
        assert.equal(c.type, 'execution.disclosure');
        if (c.type !== 'execution.disclosure') throw Error();
        assert.equal(
            c.payload.expectedRevision,
            f.value.state.disclosure.revision,
        );
        f.value.state.disclosure = {
            revision: c.payload.expectedRevision + 1,
            allow: c.payload.allow,
            changedAt: 2,
            changedBy: 'person',
        };
        return { disclosureRevision: f.value.state.disclosure.revision };
    });
    for (const status of ['prepared', 'ended'] as const) {
        f.value.state.status = status;
        const before = await access.read();
        await access.changeDisclosure(
            before.context,
            !f.value.state.disclosure.allow,
        );
        assert.equal(
            (await access.read()).aiDisclosure,
            status === 'prepared' ? 'allowed' : 'denied',
        );
    }
});
