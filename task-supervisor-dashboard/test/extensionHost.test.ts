import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { buildSync } from 'esbuild';
import type { BoardUpdate } from '../src/dashboardTypes.ts';

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

const command = [
    "  printf '%s\\n' '$VALUE | & >' \\",
    '    "$(printf test)"  ',
    '',
].join('\n');

async function host(
    mode: 'normal' | 'retry' | 'removed' | 'untrusted',
    clipboardError?: Error,
) {
    const root = await mkdtemp(join(tmpdir(), 't341-panel-host-'));
    if (mode === 'normal') {
        const ledger = join(root, '.agents', 'ローカルタスク', '監督');
        await mkdir(ledger, { recursive: true });
        await writeFile(
            join(ledger, 'registry.json'),
            JSON.stringify({
                version: 1,
                tasks: [],
                actions: [
                    {
                        id: 'U341',
                        kind: 'execution',
                        text: 'コピーの確認',
                        command,
                        done: false,
                        createdAt: 1,
                    },
                ],
            }),
        );
    }
    const uri = (path: string) => ({
        scheme: 'file',
        fsPath: path,
        toString: () => `file://${path}`,
    });
    const folder = { name: '監督', index: 0, uri: uri(root) };
    const messages: string[] = [];
    const updates: BoardUpdate[] = [];
    const clipboardWrites: string[] = [];
    const commands = new Map<string, () => Promise<void>>();
    const panels: {
        disposed: boolean;
        webview: { html: string; receive(value: unknown): void };
        dispose(): void;
    }[] = [];
    const subscriptions: { dispose(): void }[] = [];
    let initializes = 0;
    let reads = 0;
    const disposable = () => ({ dispose() {} });
    const workspace = {
        workspaceFolders: [folder],
        isTrusted: true,
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
        env: {
            clipboard: {
                async writeText(value: string) {
                    clipboardWrites.push(value);
                    if (clipboardError) throw clipboardError;
                },
            },
        },
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
                let onMessage: ((value: unknown) => void) | undefined;
                const panel = {
                    title: '',
                    disposed: false,
                    webview: {
                        html: '',
                        cspSource: 'vscode-webview://test',
                        options: {},
                        postMessage(value: BoardUpdate) {
                            updates.push(value);
                        },
                        onDidReceiveMessage(
                            callback: (value: unknown) => void,
                        ) {
                            onMessage = callback;
                            return {
                                dispose() {
                                    onMessage = undefined;
                                },
                            };
                        },
                        receive(value: unknown) {
                            assert.ok(onMessage);
                            onMessage(value);
                        },
                        asWebviewUri: (value: unknown) => value,
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
        setTimeout,
        clearTimeout,
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
        clipboardWrites,
        updates,
        revokeTrust() {
            workspace.isTrusted = false;
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
        close: async () => {
            for (const panel of panels) panel.dispose();
            for (const subscription of subscriptions) subscription.dispose();
            await rm(root, { recursive: true, force: true });
        },
    };
}

async function copyCommand(app: Awaited<ReturnType<typeof host>>) {
    const update = app.updates.find((value) => value.type === 'snapshot');
    const card = update?.snapshot.sections
        .flatMap((section) => section.cards)
        .find((value) => value.id === 'U341');
    assert.ok(card?.command);
    const { id, revision } = card.command;
    app.panels[0].webview.receive({ type: 'copy-command', id, revision });
    await setImmediate();
    return app.updates.filter((value) => value.type === 'status');
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

test('実activateで一覧のコマンド原文をコピーし、成功を表示する', async () => {
    const app = await host('normal');
    try {
        await app.open();
        const statuses = await copyCommand(app);
        assert.deepEqual(app.clipboardWrites, [command]);
        const status = statuses.at(-1);
        assert.equal(status?.state, 'success');
        assert.match(status.message, /U341 のコマンドをコピーしました/);
    } finally {
        await app.close();
    }
});

test('実activateでクリップボードへの書込みに失敗したらエラーを表示する', async () => {
    const app = await host(
        'normal',
        new Error('クリップボードが利用できません'),
    );
    try {
        await app.open();
        const statuses = await copyCommand(app);
        assert.deepEqual(app.clipboardWrites, [command]);
        assert.equal(
            statuses.some((status) => status.state === 'success'),
            false,
        );
        const status = statuses.at(-1);
        assert.equal(status?.state, 'error');
        assert.match(status.message, /クリップボードが利用できません/);
    } finally {
        await app.close();
    }
});

test('実activateで一覧を開いた後に信頼を解除したらコピーを拒否する', async () => {
    const app = await host('normal');
    try {
        await app.open();
        app.revokeTrust();
        const statuses = await copyCommand(app);
        assert.deepEqual(app.clipboardWrites, []);
        const status = statuses.at(-1);
        assert.equal(status?.state, 'error');
        assert.match(status.message, /ワークスペースの信頼が解除されました/);
    } finally {
        await app.close();
    }
});
