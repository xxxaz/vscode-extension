// cspell:words noprofile norc
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { EventEmitter } from 'node:events';
import type {
    ProcessObservation,
    ProcessSource,
    RunnerPort,
} from './executionRunner.ts';

type Launch = RunnerPort<never, never>['launch'];
const queueBytes = 128 * 1024;
type ObservedChild = Pick<
    ChildProcessWithoutNullStreams,
    'stdout' | 'stderr' | 'stdin' | 'pid'
> &
    Pick<EventEmitter, 'on' | 'off'>;
// 所在の証明は正式runner登録との接続側で行う。remoteNameだけを認可に使わない。
export function nodeExecutionProcess(
    request: Parameters<Launch>[0],
    verifyLocation: () => boolean,
    start: (request: Parameters<Launch>[0]) => ObservedChild = (r) =>
        spawn(r.executable, [...r.args], {
            cwd: r.cwd,
            stdio: ['pipe', 'pipe', 'pipe'],
        }),
): ProcessSource {
    if (!verifyLocation())
        throw new Error('本人のDevContainer実行場所を確認できません');
    if (
        request.executable !== '/bin/bash' ||
        request.args.join(' ') !== '--noprofile --norc -p -s'
    )
        throw new Error('実行形式が一致しません');
    const child = start(request);
    const queue: ProcessObservation[] = [];
    const lost = { stdout: 0, stderr: 0 };
    let buffered = 0,
        ended = false,
        disposed = false;
    let wake: (() => void) | undefined;
    const notify = () => {
        wake?.();
        wake = undefined;
    };
    const pause = () => {
        child.stdout.pause();
        child.stderr.pause();
    };
    const resume = () => {
        child.stdout.resume();
        child.stderr.resume();
    };
    const onSpawn = () => {
        queue.push({
            kind: 'spawned',
            processIdentity: `runner:${child.pid}:${randomUUID()}`,
            startedAt: Date.now(),
        });
        notify();
    };
    const onData = (stream: 'stdout' | 'stderr', bytes: Buffer) => {
        pause();
        if (buffered + bytes.length <= queueBytes) {
            queue.push({
                kind: 'output',
                stream,
                bytes: Uint8Array.from(bytes),
            });
            buffered += bytes.length;
        } else lost[stream] += bytes.length;
        notify();
    };
    const stdout = (bytes: Buffer) => onData('stdout', bytes);
    const stderr = (bytes: Buffer) => onData('stderr', bytes);
    // errorの後もcloseを待つ。spawn失敗のcodeやstdin EPIPEを正常終了へ変換しない。
    let failed = false;
    const onError = () => {
        failed = true;
    };
    const onClose = (code: number | null, signal: string | null) => {
        ended = true;
        queue.push({
            kind: 'closed',
            code: failed ? null : code,
            signal: failed ? null : signal,
        });
        notify();
    };
    child.on('spawn', onSpawn);
    child.on('error', onError);
    child.stdin.on('error', onError);
    child.stdout.on('data', stdout);
    child.stderr.on('data', stderr);
    child.on('close', onClose);
    child.stdin.end(request.stdin);
    return {
        observations: {
            async *[Symbol.asyncIterator]() {
                while (!disposed) {
                    for (const stream of ['stdout', 'stderr'] as const)
                        if (
                            lost[stream] &&
                            (!queue.length || queue[0].kind === 'closed')
                        ) {
                            const bytes = lost[stream];
                            lost[stream] = 0;
                            yield {
                                kind: 'lost-output',
                                stream,
                                bytes,
                            } as const;
                        }
                    const event = queue.shift();
                    if (event) {
                        if (event.kind === 'output')
                            buffered -= event.bytes.byteLength;
                        yield event;
                        continue;
                    }
                    if (ended) return;
                    const waiting = new Promise<void>((resolve) => {
                        wake = resolve;
                    });
                    resume();
                    await waiting;
                }
            },
        },
        [Symbol.dispose]() {
            if (disposed) return;
            disposed = true;
            child.off('spawn', onSpawn);
            child.stdout.off('data', stdout);
            child.stderr.off('data', stderr);
            child.off('close', onClose);
            // 子をkillせず、出力pipeを排出する。error listenerは未処理例外防止のため残す。
            queue.length = 0;
            buffered = 0;
            resume();
            notify();
        },
    };
}
