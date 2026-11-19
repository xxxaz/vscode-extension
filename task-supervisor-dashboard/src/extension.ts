import * as vscode from 'vscode';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { record, type Interaction } from './actions.ts';
import { Ledger, boardRunner, type Operation } from './boardClient.ts';
import { captureAnswer } from './answerEditor.ts';

export function activate(context: vscode.ExtensionContext): void {
    let busy = false;
    let view: vscode.WebviewView | undefined;
    const status = (message: string, failed = false): void => {
        void view?.webview.postMessage({ message, failed });
    };
    const perform = async (operation: Operation): Promise<void> => {
        if (!vscode.workspace.isTrusted) {
            void vscode.window.showErrorMessage(
                '信頼したワークスペースで実行してください'
            );
            return;
        }
        if (busy) {
            void vscode.window.showInformationMessage(
                '前の記録操作が終わるまでお待ちください'
            );
            return;
        }
        busy = true;
        status('操作中…');
        let reported = false;
        try {
            const folders =
                vscode.workspace.workspaceFolders?.filter(
                    (f) => f.uri.scheme === 'file'
                ) ?? [];
            const folder =
                folders.length === 1
                    ? folders[0]
                    : await vscode.window.showWorkspaceFolderPick();
            if (!folder) {
                status('操作を取り消しました');
                return;
            }
            const root = folder.uri.fsPath;
            const config = vscode.workspace.getConfiguration(
                'taskSupervisor',
                folder.uri
            );
            const run = boardRunner(
                root,
                config.get<string>('nodePath')!,
                resolve(root, config.get<string>('boardPath')!)
            );
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
                            }
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
                            { title: '回答の種類' }
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
                            { title: '前回の未保存回答があります' }
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
                                    '取消'
                                )) === '回答を確認',
                        },
                        initial
                    ),
                confirm: async (message, detail) =>
                    (await vscode.window.showWarningMessage(
                        message,
                        { modal: true, detail },
                        '記録する'
                    )) === '記録する',
                info: (message) => {
                    reported = true;
                    status(message);
                    void vscode.window.showInformationMessage(message);
                },
                error: (message) => {
                    reported = true;
                    status(message, true);
                    void vscode.window.showErrorMessage(message);
                },
            };
            await record(operation, new Ledger(root, run), ui, {
                get: (key) => context.workspaceState.get(key),
                set: async (key, value) => {
                    await context.workspaceState.update(key, value);
                },
            });
        } catch (error) {
            reported = true;
            const message = `操作を開始できませんでした: ${String(error)}`;
            status(message, true);
            void vscode.window.showErrorMessage(message);
        } finally {
            busy = false;
            if (!reported) status('記録を取り消しました');
        }
    };
    for (const operation of ['complete', 'ran', 'answer'] as const)
        context.subscriptions.push(
            vscode.commands.registerCommand(
                `xxxaz.task-supervisor.${operation}`,
                () => perform(operation)
            )
        );
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
            'xxxaz.task-supervisor.actions',
            {
                resolveWebviewView(current) {
                    view = current;
                    current.webview.options = {
                        enableScripts: true,
                        localResourceRoots: [],
                    };
                    const nonce = randomBytes(24).toString('hex');
                    current.webview.html = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}';"><style nonce="${nonce}">body{font-family:var(--vscode-font-family);padding:12px}button{display:block;width:100%;margin:8px 0;padding:8px;color:var(--vscode-button-foreground);background:var(--vscode-button-background);border:0;cursor:pointer}p{white-space:pre-wrap}</style></head><body><button data-operation="complete">完了（結果確認 OK）</button><button data-operation="ran">キック済み</button><button data-operation="answer">判断に回答（推奨・自由記述）</button><p id="status" role="status">操作を選ぶと未完了の依頼を表示します。Markdownへは書き戻しません。</p><script nonce="${nonce}">const api=acquireVsCodeApi();document.querySelectorAll('button').forEach(b=>b.onclick=()=>api.postMessage({operation:b.dataset.operation}));window.addEventListener('message',e=>{document.getElementById('status').textContent=e.data.message;});</script></body></html>`;
                    context.subscriptions.push(
                        current.webview.onDidReceiveMessage(
                            (message: unknown) => {
                                if (
                                    message &&
                                    typeof message === 'object' &&
                                    'operation' in message &&
                                    (message.operation === 'complete' ||
                                        message.operation === 'ran' ||
                                        message.operation === 'answer')
                                )
                                    void perform(message.operation);
                            }
                        )
                    );
                    current.onDidDispose(() => {
                        if (view === current) view = undefined;
                    });
                },
            }
        )
    );
}
