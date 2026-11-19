import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { buildSync } from 'esbuild';

const require = createRequire(import.meta.url);
const bundle = buildSync({
    entryPoints: [new URL('../src/extension.ts', import.meta.url).pathname],
    platform: 'node',
    format: 'cjs',
    bundle: true,
    external: ['vscode'],
    write: false,
}).outputFiles[0].text;

async function host(mode: 'retry' | 'removed' | 'untrusted') {
    const root = await mkdtemp(join(tmpdir(), 't341-panel-host-'));
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
                const panel = {
                    title: '',
                    disposed: false,
                    webview: {
                        html: '',
                        cspSource: 'vscode-webview://test',
                        options: {},
                        postMessage() {},
                        onDidReceiveMessage: disposable,
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

for (const mode of ['removed', 'untrusted'] as const) {
    test(`実activateの非同期初期化中に${mode === 'removed' ? 'ルートを除外' : '信頼を解除'}したら購読と原票読取りの前に拒否する`, async () => {
        const app = await host(mode);
        try {
            await app.open();
            assert.equal(app.panels[0].disposed, true);
            assert.equal(app.panels[0].webview.html, '');
            assert.equal(app.reads, 0);
            assert.equal(app.messages.length, 1);
        } finally {
            await app.close();
        }
    });
}
