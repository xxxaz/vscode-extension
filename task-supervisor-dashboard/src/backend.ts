import { resolve } from 'node:path';
import { boardRunner, Ledger } from './boardClient.ts';
import type { ActionGateway } from './gateway.ts';
import { readAuthority, runtimeIO } from './runtimeFiles.ts';
import {
    type Authority,
    type PendingRuntime,
    RuntimeGateway,
} from './runtimeGateway.ts';

export interface ClientState {
    get<T>(key: string): T | undefined;
    set(key: string, value: unknown): Promise<void>;
}
export async function createGateway(
    root: string,
    nodePath: string,
    boardPath: string,
    runtimeCliPath: string,
    state: ClientState,
): Promise<ActionGateway> {
    const seenKey = `taskSupervisor.authority:${root}`;
    const pendingKey = `taskSupervisor.runtimePending:${root}`;
    const observeAuthority = async () => {
        let authority: Authority | undefined;
        try {
            authority = await readAuthority(root);
        } catch (error) {
            await state.set(seenKey, 'unreadable');
            throw error;
        }
        if (authority) await state.set(seenKey, authority.epoch);
        return authority;
    };
    const authority = await observeAuthority();
    if (!authority) {
        if (state.get(seenKey) || state.get(pendingKey))
            throw new Error(
                '常駐部の正本記録が見つかりません。旧CLIへ自動で戻しません',
            );
        const guard = async (): Promise<void> => {
            if ((await observeAuthority()) || state.get(seenKey))
                throw new Error(
                    '正本の切替が始まりました。旧CLIでは変更しません',
                );
        };
        const run = boardRunner(root, nodePath, resolve(root, boardPath));
        return new Ledger(
            root,
            async (args) => {
                await guard();
                return run(args);
            },
            guard,
        );
    }
    if (authority.mode === 'preparing')
        throw new Error(
            '正本の切替中です。旧CLIと常駐受付への変更を停止しています',
        );
    const io = runtimeIO(
        root,
        boardRunner(root, nodePath, resolve(root, runtimeCliPath)),
    );
    return new RuntimeGateway(root, authority.epoch, {
        ...io,
        authority: () => readAuthority(root),
        journal: {
            get: () => state.get<PendingRuntime>(pendingKey),
            set: (value) => state.set(pendingKey, value),
        },
    });
}
