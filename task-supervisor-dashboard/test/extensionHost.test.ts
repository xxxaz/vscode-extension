import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { buildSync } from 'esbuild';
import type { BoardUpdate } from '../src/dashboardTypes.ts';
import { runtimeRelative } from '../src/runtimeFiles.ts';
import {
    noOperations,
    readyView,
    viewRow,
    waitingForExecution,
} from './viewFixture.ts';

const require = createRequire(import.meta.url);
const bundle = buildSync({
    entryPoints: [
        fileURLToPath(new URL('../src/extension.ts', import.meta.url)),
    ],
    platform: 'node',
    format: 'cjs',
    bundle: true,
    external: ['vscode'],
    write: false,
}).outputFiles[0].text;

async function host(mode: 'retry' | 'removed' | 'untrusted' | 'freshness') {
    const root = await mkdtemp(join(tmpdir(), 't341-panel-host-'));
    const initialTime = 1_700_000_000_000;
    let now = initialTime;
    let timerId = 0;
    const timers = new Map<number, { callback: () => void; delay: number }>();
    const updates: BoardUpdate[] = [];
    const updateListeners = new Set<(update: BoardUpdate) => void>();
    if (mode === 'freshness') {
        const directory = join(root, runtimeRelative);
        await mkdir(directory, { recursive: true });
        const epoch = 'epoch-1';
        const generation = 'process-1';
        const action = {
            id: 'U1',
            text: '停止前の依頼',
            done: false,
            createdAt: initialTime,
        };
        const row = viewRow(action, {
            ...waitingForExecution,
            operations: { ...noOperations, execute: true, complete: true },
        });
        for (const [name, value] of Object.entries({
            'authority.json': {
                schemaVersion: 1,
                mode: 'authoritative',
                epoch,
                migrationId: 'migration-1',
                fingerprint: 'fingerprint-1',
            },
            'heartbeat.json': { schemaVersion: 1, generation, at: initialTime },
            'snapshot.json': {
                schemaVersion: 1,
                mode: 'authoritative',
                generation,
                tasks: [],
                registry: { version: 1, tasks: [], actions: [action] },
                userActions: readyView([row], {
                    mode: 'authoritative',
                    epoch,
                    fetchedAt: initialTime,
                    error: null,
                }),
            },
        }))
            await writeFile(join(directory, name), JSON.stringify(value));
    }
    const uri = (path: string) => ({
        scheme: 'file',
        fsPath: path,
        toString: () => `file://${path}`,
    });
    const folder = { name: '監督', index: 0, uri: uri(root) };
    const messages: string[] = [];
    const commands = new Map<string, () => Promise<void>>();
    const panels: {
        disposed: boolean;
        webview: { html: string };
        receive(message: unknown): void;
        dispose(): void;
    }[] = [];
    const subscriptions: { dispose(): void }[] = [];
    let initializes = 0;
    let reads = 0;
    let gatewayLookups = 0;
    const disposable = () => ({ dispose() {} });
    const workspace = {
        workspaceFolders: [folder],
        isTrusted: true,
        getConfiguration() {
            gatewayLookups++;
            return { get: () => undefined };
        },
        createFileSystemWatcher() {
            initializes++;
            if (mode === 'retry' && initializes === 1)
                throw new Error('初回だけ監視を開始できません');
            if (mode === 'removed') workspace.workspaceFolders = [];
            if (mode === 'untrusted') workspace.isTrusted = false;
            return {
                dispose() {},
                onDidCreate: disposable,
                onDidChange: disposable,
                onDidDelete: disposable,
            };
        },
    };
    const api = {
        workspace,
        Uri: {
            joinPath: (base: ReturnType<typeof uri>, ...parts: string[]) =>
                uri(join(base.fsPath, ...parts)),
        },
        RelativePattern: class {},
        ViewColumn: { One: 1 },
        commands: {
            registerCommand(id: string, callback: () => Promise<void>) {
                commands.set(id, callback);
                return disposable();
            },
        },
        window: {
            registerWebviewViewProvider: disposable,
            registerWebviewPanelSerializer: disposable,
            showErrorMessage(message: string) {
                messages.push(message);
            },
            createWebviewPanel() {
                const listeners = new Set<() => void>();
                const incoming = new Set<(message: unknown) => void>();
                const panel = {
                    title: '',
                    disposed: false,
                    webview: {
                        html: '',
                        cspSource: 'vscode-webview://test',
                        options: {},
                        postMessage(update: BoardUpdate) {
                            updates.push(update);
                            for (const notify of updateListeners)
                                notify(update);
                        },
                        onDidReceiveMessage(
                            callback: (message: unknown) => void,
                        ) {
                            incoming.add(callback);
                            return {
                                dispose: () => {
                                    incoming.delete(callback);
                                },
                            };
                        },
                        asWebviewUri: (value: unknown) => value,
                    },
                    receive(message: unknown) {
                        for (const callback of incoming) callback(message);
                    },
                    onDidDispose(callback: () => void) {
                        listeners.add(callback);
                        return {
                            dispose() {
                                listeners.delete(callback);
                            },
                        };
                    },
                    dispose() {
                        if (panel.disposed) return;
                        panel.disposed = true;
                        for (const callback of [...listeners]) callback();
                    },
                    reveal() {},
                };
                panels.push(panel);
                return panel;
            },
        },
    };
    const module = { exports: {} as { activate(context: unknown): void } };
    runInNewContext(bundle, {
        module,
        exports: module.exports,
        process,
        Buffer,
        console,
        URL,
        Date: class extends Date {
            static override now() {
                return now;
            }
        },
        setTimeout: (callback: () => void, delay: number) => {
            const id = ++timerId;
            timers.set(id, { callback, delay });
            return id;
        },
        clearTimeout: (id: number) => {
            timers.delete(id);
        },
        require: (id: string) => {
            if (id === 'vscode') return api;
            if (id === 'node:fs/promises')
                return {
                    ...require(id),
                    readFile: (...args: unknown[]) => {
                        reads++;
                        return require(id).readFile(...args);
                    },
                };
            return require(id);
        },
    });
    module.exports.activate({
        subscriptions,
        extensionUri: uri(root),
        workspaceState: { get() {}, update: async () => {} },
    });
    return {
        panels,
        messages,
        updates,
        get gatewayLookups() {
            return gatewayLookups;
        },
        get pendingTimers() {
            return timers.size;
        },
        get initializes() {
            return initializes;
        },
        get reads() {
            return reads;
        },
        open: async () => {
            const open = commands.get('xxxaz.task-supervisor.open');
            assert.ok(open);
            await open();
        },
        refresh: async () => {
            const refresh = commands.get('xxxaz.task-supervisor.refresh');
            assert.ok(refresh);
            await refresh();
            await new Promise((resolve) => setTimeout(resolve, 30));
        },
        runTimer(delay: number, advance = 0) {
            const entry = [...timers].find(
                ([, timer]) => timer.delay === delay,
            );
            assert.ok(entry, `${delay}ms後のタイマーが必要です`);
            const [id, timer] = entry;
            timers.delete(id);
            now += advance;
            timer.callback();
        },
        nextUpdate<T extends BoardUpdate>(
            match: (update: BoardUpdate) => update is T,
        ) {
            return new Promise<T>((resolve, reject) => {
                const listener = (update: BoardUpdate) => {
                    if (!match(update)) return;
                    updateListeners.delete(listener);
                    clearTimeout(timeout);
                    resolve(update);
                };
                const timeout = setTimeout(() => {
                    updateListeners.delete(listener);
                    reject(new Error('一覧の更新通知が届きませんでした'));
                }, 2000);
                updateListeners.add(listener);
            });
        },
        close: async () => {
            for (const panel of panels) panel.dispose();
            for (const subscription of subscriptions) subscription.dispose();
            await rm(root, { recursive: true, force: true });
        },
    };
}

test('実activateの監視初期化失敗から再度開くと再試行し、未処理rejectを残さない', async () => {
    const app = await host('retry');
    try {
        await app.open();
        assert.equal(app.panels[0].disposed, true);
        await app.open();
        assert.equal(app.initializes, 2);
        assert.match(app.panels[1].webview.html, /data-workspace-uri=/);
        assert.equal(app.messages.length, 1);
    } finally {
        await app.close();
    }
});

test('ファイル通知なしの稼働期限切れを定期確認で検出し、古い行の操作を拒否する', async () => {
    const app = await host('freshness');
    try {
        await app.open();
        const ready = app.updates.find((update) => update.type === 'snapshot');
        assert.equal(ready?.type, 'snapshot');
        assert.equal(ready.snapshot.userActions?.status, 'ready');
        const card = ready.snapshot.sections
            .flatMap((section) => section.cards)
            .find((row) => row.id === 'U1');
        assert.ok(card);
        const operation = card.operations.find(
            (candidate) => candidate.operation === 'complete',
        );
        assert.ok(operation);

        const closed = app.nextUpdate(
            (update): update is Extract<BoardUpdate, { type: 'snapshot' }> =>
                update.type === 'snapshot' &&
                update.snapshot.userActions?.status === 'unavailable',
        );
        app.runTimer(5000, 31_000);
        app.runTimer(120);
        const unavailable = await closed;
        assert.match(
            unavailable.snapshot.warnings.join('\n'),
            /稼働を確認できません/,
        );
        assert.equal(
            unavailable.snapshot.userActions?.lastSuccessful?.viewVersion,
            ready.snapshot.userActions?.viewVersion,
        );
        assert.equal(unavailable.snapshot.updatedAt, ready.snapshot.updatedAt);

        const rejected = app.nextUpdate(
            (update): update is Extract<BoardUpdate, { type: 'status' }> =>
                update.type === 'status' && update.failed === true,
        );
        app.panels[0].receive({
            ...operation,
            type: 'operation',
            status: 'ready',
        });
        assert.match((await rejected).message, /一覧の依頼が変わりました/);
        assert.equal(app.gatewayLookups, 0);
    } finally {
        await app.close();
    }
    assert.equal(app.pendingTimers, 0);
});

for (const mode of ['removed', 'untrusted'] as const) {
    test(`実activateの非同期初期化中に${mode === 'removed' ? 'ルートを除外' : '信頼を解除'}したら購読と原票読取りの前に拒否する`, async () => {
        const app = await host(mode);
        try {
            await app.open();
            assert.equal(app.panels[0].disposed, true);
            assert.equal(app.panels[0].webview.html, '');
            assert.equal(app.reads, 0);
            assert.equal(app.messages.length, 1);
            await app.refresh();
            assert.equal(app.reads, 0);
        } finally {
            await app.close();
        }
    });
}
