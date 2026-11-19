import assert from 'node:assert/strict';
import { test } from 'node:test';
import type * as vscode from 'vscode';
import {
    DASHBOARD_VIEW_TYPE,
    registerDashboardPanels,
} from '../src/dashboardPanels.ts';

function workspaceFolder(
    name: string,
    scheme = 'file',
): vscode.WorkspaceFolder {
    return {
        name,
        index: 0,
        uri: {
            scheme,
            toString: () => `${scheme}:///workspace/${name}`,
        } as vscode.Uri,
    };
}

function mockPanel(title = '旧タイトル', deferDisposeEvent = false) {
    let disposeEvent: (() => void) | undefined;
    const mock = {
        title,
        disposed: false,
        reveals: 0,
        onDidDispose(listener: () => void) {
            disposeEvent = listener;
            return { dispose() {} };
        },
        dispose() {
            if (mock.disposed) return;
            mock.disposed = true;
            if (!deferDisposeEvent) disposeEvent?.();
        },
        reveal() {
            mock.reveals++;
        },
        emitDispose() {
            disposeEvent?.();
        },
    };
    return { mock, panel: mock as unknown as vscode.WebviewPanel };
}

const first = workspaceFolder('first');
const second = workspaceFolder('second');
const remote = workspaceFolder('remote', 'virtual');
const center: vscode.ViewColumn.One = 1;

function mockHost(
    folders: vscode.WorkspaceFolder[],
    attach?: Parameters<typeof registerDashboardPanels>[0]['attach'],
) {
    let command: (() => Promise<void>) | undefined;
    let serializer: vscode.WebviewPanelSerializer | undefined;
    const created: {
        args: Parameters<typeof vscode.window.createWebviewPanel>;
        view: ReturnType<typeof mockPanel>;
    }[] = [];
    const attached: {
        panel: vscode.WebviewPanel;
        folder: vscode.WorkspaceFolder;
    }[] = [];
    const errors: unknown[] = [];
    const host = {
        selected: folders[0],
        created,
        attached,
        errors,
        open() {
            assert.ok(command);
            return command();
        },
        restore(panel: vscode.WebviewPanel, state: unknown) {
            assert.ok(serializer);
            return serializer.deserializeWebviewPanel(panel, state);
        },
    };
    registerDashboardPanels({
        window: {
            createWebviewPanel(...args) {
                const view = mockPanel(args[1]);
                created.push({ args, view });
                return view.panel;
            },
            registerWebviewPanelSerializer(viewType, registered) {
                assert.equal(viewType, DASHBOARD_VIEW_TYPE);
                serializer = registered;
                return { dispose() {} };
            },
        },
        registerCommand(id, callback) {
            assert.equal(id, 'xxxaz.task-supervisor.open');
            command = callback;
            return { dispose() {} };
        },
        column: center,
        chooseFolder: () => host.selected,
        folders: () => folders,
        attach(panel, folder) {
            attached.push({ panel, folder });
            return attach?.(panel, folder);
        },
        onError(error) {
            errors.push(error);
        },
    });
    return host;
}

test('保存したフォルダーのタブを復元し、同じフォルダーを開くと再利用する', async () => {
    const host = mockHost([first, second]);
    const view = mockPanel();
    await host.restore(view.panel, {
        version: 1,
        workspaceUri: second.uri.toString(),
    });
    assert.deepEqual(host.attached, [{ panel: view.panel, folder: second }]);
    assert.equal(view.mock.title, '監督のダッシュボード — second');
    assert.equal(view.mock.disposed, false);

    const duplicate = mockPanel();
    await host.restore(duplicate.panel, {
        workspaceUri: second.uri.toString(),
    });
    assert.equal(duplicate.mock.disposed, true);
    assert.deepEqual(host.attached, [{ panel: view.panel, folder: second }]);
    assert.deepEqual(host.errors, []);

    host.selected = second;
    await host.open();
    assert.equal(view.mock.reveals, 1);
    assert.equal(host.created.length, 0);

    host.selected = first;
    await host.open();
    const [created] = host.created;
    assert.deepEqual(created.args, [
        DASHBOARD_VIEW_TYPE,
        '監督のダッシュボード — first',
        center,
        { enableScripts: true, retainContextWhenHidden: true },
    ]);
    await host.open();
    assert.equal(host.created.length, 1);
    assert.equal(created.view.mock.reveals, 1);
    assert.deepEqual(host.attached[1], {
        panel: created.view.panel,
        folder: first,
    });
});

test('ワークスペースURIのない保存状態はルート構成に関わらず拒否する', async () => {
    const state = {
        version: 1,
        query: 'タスク',
        sections: {},
        cards: {},
        scrollTop: 0,
    };
    for (const folders of [[first], [first, second], [first, remote]]) {
        const host = mockHost(folders);
        const view = mockPanel();
        await host.restore(view.panel, state);
        assert.equal(view.mock.disposed, true);
        assert.deepEqual(host.attached, []);
        assert.equal(host.errors.length, 1);
    }
});

test('閉じたフォルダーやfile以外のURI、壊れた保存状態を復元しない', async () => {
    const host = mockHost([first, remote]);
    for (const state of [
        undefined,
        'file:///workspace/first',
        {},
        { version: 1, workspaceUri: undefined },
        { version: 1, workspaceUri: null },
        { version: 1, workspaceUri: 42 },
        { version: 1, workspaceUri: '' },
        { version: 1, workspaceUri: second.uri.toString() },
        { version: 1, workspaceUri: remote.uri.toString() },
        { version: 1, workspaceUri: `${first.uri.toString()}/` },
    ]) {
        const view = mockPanel();
        await host.restore(view.panel, state);
        assert.equal(view.mock.disposed, true);
        const error = host.errors.pop();
        assert.ok(error instanceof Error);
        assert.match(error.message, /ダッシュボードを復元できません/);
    }
    assert.deepEqual(host.attached, []);

    host.selected = remote;
    await host.open();
    assert.deepEqual(host.created, []);
});

test('復元とコマンドが重なったときは開始順に関わらず保存済みタブを残す', async () => {
    for (const restoreFirst of [true, false]) {
        let notifyStarted: () => void = () =>
            assert.fail('開始の待ち合わせがありません');
        const started = new Promise<void>((resolve) => {
            notifyStarted = resolve;
        });
        let finishAttach: () => void = () =>
            assert.fail('接続の待ち合わせがありません');
        const pendingAttach = new Promise<void>((resolve) => {
            finishAttach = resolve;
        });
        const host = mockHost([first], () => {
            notifyStarted();
            return pendingAttach;
        });
        const restored = mockPanel();
        const restore = () =>
            host.restore(restored.panel, {
                workspaceUri: first.uri.toString(),
            });
        const open = () => host.open();
        const pending = restoreFirst ? restore() : open();
        await started;
        const concurrent = restoreFirst ? open() : restore();
        finishAttach();
        await Promise.all([pending, concurrent]);

        assert.equal(host.attached.length, restoreFirst ? 1 : 2);
        assert.equal(host.attached.at(-1)?.panel, restored.panel);
        assert.deepEqual(host.errors, []);
        assert.equal(restored.mock.disposed, false);
        assert.equal(host.created.length, restoreFirst ? 0 : 1);
        if (!restoreFirst)
            assert.equal(host.created[0].view.mock.disposed, true);

        const reveals = restored.mock.reveals;
        await host.open();
        assert.equal(restored.mock.reveals, reveals + 1);
        assert.equal(host.created.length, restoreFirst ? 0 : 1);
    }
});

test('破棄された手動タブの接続が遅れて失敗しても復元したタブを再利用する', async () => {
    let rejectManualAttach: (error: Error) => void = () =>
        assert.fail('手動タブの接続が始まっていません');
    const manualAttach = new Promise<void>((_, reject) => {
        rejectManualAttach = reject;
    });
    const restored = mockPanel();
    const host = mockHost([first], (panel) => {
        if (panel !== restored.panel) return manualAttach;
    });
    const manual = host.open();
    await Promise.resolve();
    const restoring = host.restore(restored.panel, {
        workspaceUri: first.uri.toString(),
    });
    rejectManualAttach(new Error('古いタブの接続失敗'));
    await Promise.all([manual, restoring]);

    assert.equal(host.created[0].view.mock.disposed, true);
    assert.equal(restored.mock.disposed, false);
    assert.deepEqual(host.errors, []);
    await host.open();
    assert.equal(host.created.length, 1);
    assert.equal(restored.mock.reveals, 1);
});

test('接続失敗でタブを破棄し、遅れて届いた破棄通知の後も開き直したタブを再利用する', async () => {
    const failure = new Error('接続に失敗しました');
    let fail = true;
    const host = mockHost([first], () => {
        if (fail) throw failure;
    });
    const failed = mockPanel(undefined, true);
    await host.restore(failed.panel, { workspaceUri: first.uri.toString() });
    assert.equal(failed.mock.disposed, true);
    assert.deepEqual(host.errors, [failure]);

    fail = false;
    await host.open();
    const [retry] = host.created;
    failed.mock.emitDispose();
    await host.open();
    assert.equal(host.created.length, 1);
    assert.equal(retry.view.mock.reveals, 1);

    retry.view.mock.dispose();
    await host.open();
    assert.equal(host.created.length, 2);
});
