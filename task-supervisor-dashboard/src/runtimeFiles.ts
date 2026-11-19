import { constants } from 'node:fs';
import {
    lstat,
    mkdtemp,
    open,
    readFile,
    rm,
    writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { Action } from './boardClient.ts';
import type {
    Authority,
    Receipt,
    RuntimeAnswerContext,
    RuntimeCommand,
    RuntimeResult,
    RuntimeSnapshot,
} from './runtimeGateway.ts';

// VS Code 1.85のNodeでもesbuildのusing補助と同じシンボルを使う。
const asyncDispose: typeof Symbol.asyncDispose =
    Symbol.asyncDispose ??
    (Symbol.for('Symbol.asyncDispose') as typeof Symbol.asyncDispose);

export const runtimeRelative = '.agents/ローカルタスク/監督/runtime';
export async function readAuthority(
    root: string,
): Promise<Authority | undefined> {
    let text: string;
    try {
        text = await readFile(
            join(root, runtimeRelative, 'authority.json'),
            'utf8',
        );
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT')
            return undefined;
        throw error;
    }
    const a = JSON.parse(text) as Authority;
    if (
        a.schemaVersion !== 1 ||
        !['preparing', 'authoritative'].includes(a.mode) ||
        ![a.epoch, a.migrationId, a.fingerprint].every(
            (v) => typeof v === 'string' && v.length > 0,
        )
    )
        throw new Error('正本の切替記録が不正です。旧CLIへ戻しません');
    return a;
}
export function runtimeIO(
    root: string,
    run: (args: string[]) => Promise<string>,
) {
    return {
        snapshot: async (): Promise<RuntimeSnapshot> =>
            JSON.parse(
                await readFile(
                    join(root, runtimeRelative, 'snapshot.json'),
                    'utf8',
                ),
            ) as RuntimeSnapshot,
        capabilities: async (): Promise<{
            schemaVersion: 1;
            authoritativeWrites: boolean;
            operations: string[];
        }> => JSON.parse(await run(['capabilities'])),
        answerContext: async (
            action: Action,
            documentVersion?: string,
        ): Promise<RuntimeAnswerContext> =>
            JSON.parse(
                await run([
                    'answer-context',
                    action.id,
                    ...(documentVersion
                        ? ['--document-version', documentVersion]
                        : []),
                ]),
            ),
        submit: async (command: RuntimeCommand): Promise<Receipt> => {
            const directory = await mkdtemp(
                join(tmpdir(), 'supervisor-command-'),
            );
            await using _cleanup = {
                async [asyncDispose]() {
                    await rm(directory, { recursive: true, force: true });
                },
            };
            const path = join(directory, 'command.json');
            await writeFile(path, JSON.stringify(command), { mode: 0o600 });
            return JSON.parse(await run(['submit', path])) as Receipt;
        },
        result: async (
            receipt: Receipt,
        ): Promise<RuntimeResult | undefined> => {
            const base = resolve(root, runtimeRelative, 'results');
            if (
                !isAbsolute(receipt.resultPath) ||
                dirname(resolve(receipt.resultPath)) !== base
            )
                throw new Error(
                    '常駐部の結果パスが対象のresults配下ではありません',
                );
            let directory = resolve(root);
            for (const part of [...runtimeRelative.split('/'), 'results']) {
                directory = join(directory, part);
                const stat = await lstat(directory);
                if (!stat.isDirectory() || stat.isSymbolicLink())
                    throw new Error('常駐部の結果ディレクトリが不正です');
            }
            try {
                const file = await open(
                    receipt.resultPath,
                    constants.O_RDONLY |
                        constants.O_NOFOLLOW |
                        constants.O_NONBLOCK,
                );
                await using _cleanup = {
                    async [asyncDispose]() {
                        await file.close();
                    },
                };
                const stat = await file.stat();
                if (!stat.isFile() || stat.size > 256 * 1024)
                    throw new Error(
                        '常駐部の結果ファイルの種類またはサイズが不正です',
                    );
                return JSON.parse(await file.readFile('utf8')) as RuntimeResult;
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code === 'ENOENT')
                    return undefined;
                throw error;
            }
        },
    };
}
