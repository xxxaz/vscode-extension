import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import * as vscode from 'vscode';
import { type Interaction, record } from './actions.ts';
import { captureAnswer } from './answerEditor.ts';
import { createGateway } from './backend.ts';
import type { Operation } from './boardClient.ts';
import { BoardFeed } from './boardFeed.ts';
import {
    findBoardLink,
    hasBoardOperation,
    isOutsideRelative,
    parseBoardMessage,
    resolveBoardTarget,
} from './boardHost.ts';
import { BOARD_FILES, BoardReader } from './boardReader.ts';
import type { BoardUpdate } from './dashboardTypes.ts';
import { boardHtml } from './dashboardWebview.ts';

export function activate(context: vscode.ExtensionContext): void {
    let busy = false;
    type Entry = {
        folder: vscode.WorkspaceFolder;
        feed: BoardFeed;
        views: number;
    };
    const entries = new Map<string, Promise<Entry>>();
    const panels = new Map<string, vscode.WebviewPanel>();
    let lastStatus: Extract<BoardUpdate, { type: 'status' }> = {
        type: 'status',
        message: '一覧の依頼から操作できます。',
        state: 'info',
    };
    const status = (
        message: string,
        failed = false,
        state: 'info' | 'pending' | 'success' | 'error' = failed
            ? 'error'
            : 'info',
    ): void => {
        lastStatus = { type: 'status', message, failed, state, busy };
        for (const entry of entries.values())
            void entry.then((e) => e.feed.publish(lastStatus));
    };
    const folders = () =>
        vscode.workspace.workspaceFolders?.filter(
            (f) => f.uri.scheme === 'file',
        ) ?? [];
    const chooseFolder = async () =>
        folders().length === 1
            ? folders()[0]
            : vscode.window.showWorkspaceFolderPick();
    const gatewayFor = async (folder: vscode.WorkspaceFolder) => {
        const config = vscode.workspace.getConfiguration(
            'taskSupervisor',
            folder.uri,
        );
        const nodePath = config.get<string>('nodePath');
        const boardPath = config.get<string>('boardPath');
        const runtimeCliPath = config.get<string>('runtimeCliPath');
        if (!nodePath || !boardPath || !runtimeCliPath)
            throw new Error('NodeとCLIのパスをマシン設定で確認してください');
        return createGateway(
            folder.uri.fsPath,
            nodePath,
            boardPath,
            runtimeCliPath,
            {
                get: (key) => context.workspaceState.get(key),
                set: async (key, value) => {
                    await context.workspaceState.update(key, value);
                },
            },
        );
    };
    const entryFor = (folder: vscode.WorkspaceFolder): Promise<Entry> => {
        const root = folder.uri.fsPath;
        const existing = entries.get(root);
        if (existing) return existing;
        const promise = (async () => {
            let repoUrl: string | undefined;
            try {
                const remote = (
                    await promisify(execFile)(
                        'git',
                        ['config', '--get', 'remote.origin.url'],
                        {
                            cwd: root,
                            encoding: 'utf8',
                            timeout: 10000,
                            maxBuffer: 16384,
                        },
                    )
                ).stdout.trim();
                const value = new URL(
                    remote.replace(/^git@([^:]+):/, 'https://$1/'),
                );
                if (value.protocol === 'https:' || value.protocol === 'http:') {
                    value.username = '';
                    value.password = '';
                    repoUrl = value.href
                        .replace(/\.git\/?$/, '')
                        .replace(/\/$/, '');
                }
            } catch {
                /* Gitの観測URLが無ければ事実にあるリンクだけを表示する。 */
            }
            const reader = new BoardReader(root, {
                gateway: () => gatewayFor(folder),
                authoritySeen: () =>
                    !!context.workspaceState.get(
                        `taskSupervisor.authority:${root}`,
                    ),
                markAuthorityObserved: async (epoch) => {
                    await context.workspaceState.update(
                        `taskSupervisor.authority:${root}`,
                        epoch,
                    );
                },
                repoUrl,
            });
            const entry: Entry = {
                folder,
                views: 0,
                feed: new BoardFeed(async () => ({
                    ...(await reader.read()),
                    workspace: folder.name,
                })),
            };
            const watcher = vscode.workspace.createFileSystemWatcher(
                new vscode.RelativePattern(
                    folder,
                    '.agents/ローカルタスク/監督/**',
                ),
            );
            const changed = (uri: vscode.Uri) => {
                if (
                    entry.views > 0 &&
                    BOARD_FILES.some(
                        (path) => resolve(root, path) === uri.fsPath,
                    )
                )
                    entry.feed.request();
            };
            context.subscriptions.push(
                watcher,
                watcher.onDidCreate(changed),
                watcher.onDidChange(changed),
                watcher.onDidDelete(changed),
                { dispose: () => entry.feed.dispose() },
            );
            return entry;
        })();
        entries.set(root, promise);
        return promise;
    };
    const perform = async (
        operation: Operation,
        target?: {
            folder: vscode.WorkspaceFolder;
            id: string;
            revision: string;
        },
    ): Promise<void> => {
        if (
            target &&
            !folders().some(
                (folder) =>
                    folder.uri.toString() === target.folder.uri.toString(),
            )
        ) {
            status(
                '対象のワークスペースが閉じられました。一覧を開き直してください',
                true,
            );
            return;
        }
        if (!vscode.workspace.isTrusted) {
            void vscode.window.showErrorMessage(
                '信頼したワークスペースで実行してください',
            );
            return;
        }
        if (busy) {
            void vscode.window.showInformationMessage(
                '前の記録操作が終わるまでお待ちください',
            );
            return;
        }
        busy = true;
        status('操作中…');
        let reported = false;
        try {
            const folder = target?.folder ?? (await chooseFolder());
            if (!folder) {
                status('操作を取り消しました');
                return;
            }
            const gateway = await gatewayFor(folder);
            const ui: Interaction = {
                pick: async (actions, op) =>
                    (
                        await vscode.window.showQuickPick(
                            actions.map((a) => ({
                                label: `${a.id} ${a.summary ?? a.text.split('\n')[0]}`,
                                description: `${a.taskId ?? '単独'} / 優先度 ${a.priority ?? '未指定'}${a.ranAt !== undefined ? ' / キック済み' : ''}`,
                                detail: a.text,
                                action: a,
                            })),
                            {
                                title:
                                    op === 'answer'
                                        ? '回答する判断依頼'
                                        : op === 'ran'
                                          ? 'キック済みにする依頼'
                                          : '完了にする依頼',
                                matchOnDescription: true,
                                matchOnDetail: true,
                            },
                        )
                    )?.action,
                choice: async () =>
                    (
                        await vscode.window.showQuickPick(
                            [
                                {
                                    label: '推奨で進める',
                                    value: 'recommended' as const,
                                },
                                {
                                    label: '自由記述で回答',
                                    value: 'custom' as const,
                                },
                            ],
                            { title: '回答の種類' },
                        )
                    )?.value,
                recover: async () =>
                    (
                        await vscode.window.showQuickPick(
                            [
                                {
                                    label: '同じ内容を同じ操作IDで再送',
                                    value: 'retry' as const,
                                },
                                {
                                    label: '依頼を確認して入力し直す',
                                    value: 'edit' as const,
                                },
                            ],
                            { title: '前回の未保存回答があります' },
                        )
                    )?.value,
                input: async (title, value) =>
                    vscode.window.showInputBox({
                        title,
                        value,
                        ignoreFocusOut: true,
                    }),
                answerInput: async (initial) =>
                    captureAnswer(
                        {
                            open: async (content) =>
                                vscode.workspace.openTextDocument({
                                    language: 'plaintext',
                                    content,
                                }),
                            show: async (document) => {
                                await vscode.window.showTextDocument(document, {
                                    preview: false,
                                });
                            },
                            confirm: async () =>
                                (await vscode.window.showInformationMessage(
                                    '開いた無題のテキストへ回答を入力し、この通知の「回答を確認」を押してください。ファイル保存は不要です。',
                                    '回答を確認',
                                    '取消',
                                )) === '回答を確認',
                        },
                        initial,
                    ),
                confirm: async (message, detail) =>
                    (await vscode.window.showWarningMessage(
                        message,
                        { modal: true, detail },
                        '記録する',
                    )) === '記録する',
                info: (message, state = 'info') => {
                    reported = true;
                    status(message, false, state);
                    void vscode.window.showInformationMessage(message);
                },
                error: (message) => {
                    reported = true;
                    status(message, true);
                    void vscode.window.showErrorMessage(message);
                },
            };
            await record(
                operation,
                gateway,
                ui,
                {
                    get: (key) => context.workspaceState.get(key),
                    set: async (key, value) => {
                        await context.workspaceState.update(key, value);
                    },
                },
                target,
            );
        } catch (error) {
            reported = true;
            const message = `操作を開始できませんでした: ${String(error)}`;
            status(message, true);
            void vscode.window.showErrorMessage(message);
        } finally {
            busy = false;
            if (!reported) status('記録を取り消しました');
            else
                status(lastStatus.message, lastStatus.failed, lastStatus.state);
            for (const entry of entries.values())
                void entry.then((e) => {
                    if (e.views > 0) e.feed.request();
                });
        }
    };
    for (const operation of ['complete', 'ran', 'answer'] as const)
        context.subscriptions.push(
            vscode.commands.registerCommand(
                `xxxaz.task-supervisor.${operation}`,
                () => perform(operation),
            ),
        );
    const attach = async (
        owner: vscode.WebviewPanel | vscode.WebviewView,
        folder: vscode.WorkspaceFolder,
    ): Promise<void> => {
        if (!vscode.workspace.isTrusted)
            throw new Error('信頼したワークスペースで一覧を開いてください');
        const entry = await entryFor(folder);
        const webview = owner.webview;
        const subscriptions: vscode.Disposable[] = [];
        let closed = false;
        entry.views++;
        const send = (message: BoardUpdate) => {
            if (!closed) void webview.postMessage(message);
        };
        const unsubscribe = entry.feed.subscribe(send);
        subscriptions.push(
            owner.onDidDispose(() => {
                closed = true;
                entry.views--;
                unsubscribe();
                for (const subscription of subscriptions)
                    subscription.dispose();
            }),
        );
        subscriptions.push(
            webview.onDidReceiveMessage((value: unknown) => {
                void (async () => {
                    const message = parseBoardMessage(value);
                    if (!message) return;
                    if (message.type === 'ready') {
                        entry.feed.replay(send);
                        send(lastStatus);
                        entry.feed.request();
                    } else if (message.type === 'refresh') {
                        await entry.feed.refresh();
                    } else if (message.type === 'operation') {
                        if (
                            !entry.feed.current ||
                            !hasBoardOperation(entry.feed.current, message)
                        )
                            throw new Error(
                                '一覧の依頼が変わりました。最新の行を確認してください',
                            );
                        await perform(message.operation, {
                            folder,
                            id: message.id,
                            revision: message.revision,
                        });
                    } else if (message.type === 'open') {
                        const link =
                            entry.feed.current &&
                            findBoardLink(entry.feed.current, message.linkId);
                        if (!link)
                            throw new Error(
                                'このリンクは現在の一覧にありません',
                            );
                        const target = resolveBoardTarget(
                            folder.uri.fsPath,
                            link.target,
                        );
                        if ('external' in target)
                            await vscode.env.openExternal(
                                vscode.Uri.parse(target.external),
                            );
                        else {
                            const base = await realpath(folder.uri.fsPath);
                            const path = await realpath(target.file);
                            const rel = relative(base, path);
                            if (isOutsideRelative(rel))
                                throw new Error(
                                    'リンク先がワークスペース外を指しています',
                                );
                            const uri = vscode.Uri.file(path);
                            if ((await stat(path)).isDirectory())
                                await vscode.commands.executeCommand(
                                    'revealInExplorer',
                                    uri,
                                );
                            else
                                await vscode.window.showTextDocument(
                                    await vscode.workspace.openTextDocument(
                                        uri,
                                    ),
                                    { preview: false },
                                );
                        }
                    }
                })().catch((error) =>
                    status(
                        `一覧の操作を開始できませんでした: ${String(error)}`,
                        true,
                    ),
                );
            }),
        );
        webview.options = {
            enableScripts: true,
            localResourceRoots: [
                vscode.Uri.joinPath(context.extensionUri, 'dist'),
            ],
        };
        webview.html = boardHtml(
            webview.cspSource,
            randomBytes(24).toString('hex'),
            webview
                .asWebviewUri(
                    vscode.Uri.joinPath(
                        context.extensionUri,
                        'dist',
                        'dashboard.js',
                    ),
                )
                .toString(),
        );
        await entry.feed.refresh();
    };
    context.subscriptions.push(
        vscode.commands.registerCommand(
            'xxxaz.task-supervisor.open',
            async () => {
                try {
                    const folder = await chooseFolder();
                    if (!folder) return;
                    const existing = panels.get(folder.uri.fsPath);
                    if (existing) {
                        existing.reveal();
                        return;
                    }
                    const panel = vscode.window.createWebviewPanel(
                        'xxxaz.task-supervisor.dashboard',
                        `進行中タスク — ${folder.name}`,
                        vscode.ViewColumn.One,
                        { enableScripts: true, retainContextWhenHidden: true },
                    );
                    panels.set(folder.uri.fsPath, panel);
                    panel.onDidDispose(() => panels.delete(folder.uri.fsPath));
                    await attach(panel, folder);
                } catch (error) {
                    status(`一覧を開けませんでした: ${String(error)}`, true);
                }
            },
        ),
    );
    context.subscriptions.push(
        vscode.commands.registerCommand('xxxaz.task-supervisor.refresh', () => {
            for (const entry of entries.values())
                void entry.then((e) => e.feed.refresh());
        }),
    );
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
            'xxxaz.task-supervisor.actions',
            {
                resolveWebviewView(current) {
                    const folder = folders()[0];
                    if (!folder) {
                        current.webview.html =
                            '<p>監督台帳のあるフォルダーを開いてください。</p>';
                        return;
                    }
                    current.description = folder.name;
                    void attach(current, folder).catch((error) => {
                        status(
                            `一覧を開けませんでした: ${String(error)}`,
                            true,
                        );
                        void vscode.window.showErrorMessage(String(error));
                    });
                },
            },
            { webviewOptions: { retainContextWhenHidden: true } },
        ),
    );
}
