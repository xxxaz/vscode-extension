// cspell:words noprofile norc
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
    KnownRecordRejection,
    type RecordChannel,
    RecordConnection,
    recordCaptureLimits,
} from '../src/recordConnection.ts';

const command = "printf '原文\\n'";
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
test('同じ正式readの依頼版と本文を表示し、組違いと確認中の改訂はDB送信前に拒否する', async () => {
    const f = fixture(),
        original = f.channel.review;
    let confirms = 0;
    f.channel.review = async (id) => ({
        ...(await original(id)),
        input: { actionId: id, requestVersion: 'another-version' },
        command: '別の正式版',
    });
    await assert.rejects(
        f.connection.prepare('U1', 'request-version', '/workspace', [], {
            ...f.approval,
            confirm: async () => {
                confirms++;
                return true;
            },
        }),
    );
    assert.equal(confirms, 0);
    assert.equal(f.commands.length, 0);
    f.channel.review = original;
    await assert.rejects(
        f.connection.prepare('U1', 'request-version', '/workspace', [], {
            ...f.approval,
            confirm: async (p) => {
                assert.equal(p.command, command);
                f.channel.review = async (id) => ({
                    ...(await original(id)),
                    input: { actionId: id, requestVersion: 'updated' },
                    command: '改訂後',
                });
                return true;
            },
        }),
    );
    assert.equal(f.commands.length, 0);
});
test('prepare参照を保存中に所在が失効したら正式受付へ送らない', async () => {
    const f = fixture();
    let allowed = true;
    await assert.rejects(
        f.connection.prepare('U1', 'request-version', '/workspace', [], {
            ...f.approval,
            allowed: async () => allowed,
            keepReference: async () => {
                allowed = false;
            },
        }),
    );
    assert.equal(f.commands.length, 0);
});
test('内部write期限後は変更を停止し、遅延ackで自動復帰しない', async () => {
    const f = fixture(5),
        access = f.connection.disclosure(f.attempt.attemptId, async () => true);
    let late: (r: RecordResult) => void = () => {
        throw Error('未送信');
    };
    f.setSubmit(
        () =>
            new Promise((resolve) => {
                late = resolve;
            }),
    );
    await assert.rejects(
        access.changeDisclosure((await access.read()).context, true),
        /応答を確認できません/,
    );
    assert.equal((await access.read()).canChangeDisclosure, false);
    late({ disclosureRevision: 1 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal((await access.read()).canChangeDisclosure, false);
    await assert.rejects(
        access.changeDisclosure((await access.read()).context, false),
    );
    assert.equal(f.commands.length, 1);
});
test('非同期所在確認の途中と起動直前に接続停止を再検査する', async () => {
    const f = fixture(),
        c = await f.prepare();
    let finishCheck: (v: boolean) => void = () => {};
    const port = f.connection.runner({
        ...f.ui,
        allowed: () =>
            new Promise((resolve) => {
                finishCheck = resolve;
            }),
    });
    const checking = port.allowed(c);
    f.setSubmit(() => {
        throw Error('通信不明');
    });
    const access = f.connection.disclosure(
        c.attempt.attemptId,
        async () => true,
    );
    await assert.rejects(
        access.changeDisclosure((await access.read()).context, true),
    );
    finishCheck(true);
    assert.equal(await checking, false);
    assert.throws(
        () =>
            port.launch({
                executable: '/bin/bash',
                args: ['--noprofile', '--norc', '-p', '-s'],
                stdin: command,
                cwd: '/workspace',
            }),
        /受付停止中/,
    );
});
test('capture側の短い期限が先に切れても接続へ不明を通知し開示変更を止める', async () => {
    const f = fixture(100),
        c = await f.prepare();
    let late: (r: RecordResult) => void = () => {};
    f.setSubmit(
        () =>
            new Promise((resolve) => {
                late = resolve;
            }),
    );
    const capture = new ExecutionCapture(f.connection.runner(f.ui).output(c), {
        ...recordCaptureLimits,
        ackTimeoutMs: 5,
    });
    await capture.consume('stdout', new TextEncoder().encode('A'));
    assert.equal(capture.finish().status, 'unknown');
    assert.equal(
        (
            await f.connection
                .disclosure(c.attempt.attemptId, async () => true)
                .read()
        ).canChangeDisclosure,
        false,
    );
    late({ stored: true, seq: 1 });
});
test('DB準備より前に全文確認し、取消と参照保存失敗では容量予約の受付を送らない', async () => {
    const f = fixture();
    let references = 0;
    const result = await f.connection.prepare(
        'U1',
        'request-version',
        '/workspace',
        [],
        {
            ...f.approval,
            confirm: async (p) => {
                assert.equal(p.command, command);
                return false;
            },
            keepReference: async () => {
                references++;
            },
        },
    );
    assert.equal(result, null);
    assert.equal(references, 0);
    assert.equal(f.commands.length, 0);
    await assert.rejects(
        f.connection.prepare('U1', 'request-version', '/workspace', [], {
            ...f.approval,
            keepReference: async () => {
                throw Error('参照保存不可');
            },
        }),
    );
    assert.equal(f.commands.length, 0);
    assert.ok(await f.prepare());
});
test('正式adapterが発行していないcontextと差替えた本文はclaim前に拒否する', async () => {
    const f = fixture(),
        original = await f.prepare(),
        port = f.connection.runner({ ...f.ui, allowed: async () => true });
    const forged = {
        ...original,
        preview: { ...original.preview, command: '別の実行本文' },
    };
    assert.equal(await port.allowed(forged), false);
    await assert.rejects(port.claim(forged), /確認済みcontext/);
    assert.equal(f.commands.length, 1);
});
test('開示版の既知拒否後は明示再読取りの版で取消でき、応答不明後は変更を無効にする', async () => {
    const f = fixture(),
        access = f.connection.disclosure(f.attempt.attemptId, async () => true);
    const old = await access.read();
    f.value.state.disclosure = {
        ...f.value.state.disclosure,
        revision: 1,
        allow: true,
    };
    let first = true;
    f.setSubmit((c) => {
        if (first) {
            first = false;
            throw new KnownRecordRejection('開示版の競合');
        }
        assert.equal(c.type, 'execution.disclosure');
        if (c.type !== 'execution.disclosure') throw Error();
        assert.equal(c.payload.expectedRevision, 1);
        f.value.state.disclosure = {
            revision: 2,
            allow: c.payload.allow,
            changedBy: 'person',
            changedAt: 3,
        };
        return { disclosureRevision: 2 };
    });
    await assert.rejects(access.changeDisclosure(old.context, false));
    const fresh = await access.read();
    assert.equal(fresh.canChangeDisclosure, true);
    await access.changeDisclosure(fresh.context, false);
    assert.equal((await access.read()).aiDisclosure, 'denied');
    assert.notEqual(f.commands[0].commandId, f.commands[1].commandId);
    const unknown = fixture(),
        blocked = unknown.connection.disclosure(
            unknown.attempt.attemptId,
            async () => true,
        );
    unknown.setSubmit(() => {
        throw Error('通信不明');
    });
    await assert.rejects(
        blocked.changeDisclosure((await blocked.read()).context, true),
    );
    assert.equal((await blocked.read()).canChangeDisclosure, false);
    await assert.rejects(
        blocked.changeDisclosure((await blocked.read()).context, false),
    );
    assert.equal(unknown.commands.length, 1);
});
test('metadata-onlyと開示変更権限未確認は本人の本文表示とせず変更操作を送らない', async () => {
    for (const metadata of [true, false]) {
        const f = fixture();
        if (metadata) Reflect.deleteProperty(f.value.attempt, 'command');
        const access = f.connection.disclosure(
            f.attempt.attemptId,
            async () => metadata,
        );
        const view = await access.read();
        assert.equal(view.canChangeDisclosure, false);
        if (metadata) assert.match(view.userDisplay, /メタデータのみ/);
        await assert.rejects(access.changeDisclosure(view.context, true));
        assert.equal(f.commands.length, 0);
    }
});
function fixture(responseTimeoutMs?: number) {
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
        async review(actionId) {
            return {
                targetId: 'T1',
                input: { actionId, requestVersion: 'request-version' },
                command,
                taskVersion: version,
            };
        },
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
        responseTimeoutMs,
    );
    const shown: string[] = [],
        warnings: string[] = [];
    const approval = {
        allowed: async () => true,
        confirm: async () => true,
        keepReference: async () => {},
    };
    const prepare = async () => {
        const c = await connection.prepare(
            'U1',
            'request-version',
            '/workspace',
            [],
            approval,
        );
        assert.ok(c);
        return c;
    };
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
        channel,
        attempt,
        value,
        commands,
        connection,
        approval,
        prepare,
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
    const c = await f.prepare();
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
    await assert.rejects(f.prepare());
    await assert.rejects(f.prepare());
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
        await assert.rejects(f.prepare());
    }
});
test('appliedだけのackを保存済みにせず、stored=false/drain=trueは確定した欠落として数える', async () => {
    for (const rejected of [false, true]) {
        const f = fixture(),
            c = await f.prepare();
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
    const access = f.connection.disclosure(
        f.attempt.attemptId,
        async () => true,
    );
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
