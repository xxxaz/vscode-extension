import type * as vscode from 'vscode';

export const DASHBOARD_VIEW_TYPE = 'xxxaz.task-supervisor.dashboard';
const OPEN_DASHBOARD_COMMAND = 'xxxaz.task-supervisor.open';

interface DashboardPanelDependencies {
    window: Pick<
        typeof vscode.window,
        'createWebviewPanel' | 'registerWebviewPanelSerializer'
    >;
    registerCommand: (
        command: string,
        callback: () => Promise<void>,
    ) => vscode.Disposable;
    column: vscode.ViewColumn.One;
    chooseFolder: () =>
        | vscode.WorkspaceFolder
        | undefined
        | PromiseLike<vscode.WorkspaceFolder | undefined>;
    folders: () => readonly vscode.WorkspaceFolder[];
    attach: (
        panel: vscode.WebviewPanel,
        folder: vscode.WorkspaceFolder,
    ) => void | PromiseLike<void>;
    onError: (error: unknown) => void;
}

const panelTitle = (folder: vscode.WorkspaceFolder) =>
    `監督のダッシュボード — ${folder.name}`;

function restoreFolder(
    folders: readonly vscode.WorkspaceFolder[],
    state: unknown,
): vscode.WorkspaceFolder | undefined {
    if (!state || typeof state !== 'object' || Array.isArray(state)) return;
    if ('workspaceUri' in state) {
        if (typeof state.workspaceUri !== 'string') return;
        return folders.find(
            (folder) => folder.uri.toString() === state.workspaceUri,
        );
    }
    if ('version' in state && state.version === 1 && folders.length === 1)
        return folders[0];
}

export function registerDashboardPanels({
    window,
    registerCommand,
    column,
    chooseFolder,
    folders,
    attach,
    onError,
}: DashboardPanelDependencies): vscode.Disposable[] {
    const panels = new Map<string, vscode.WebviewPanel>();
    const fileFolders = () =>
        folders().filter((folder) => folder.uri.scheme === 'file');
    const attachPanel = async (
        panel: vscode.WebviewPanel,
        folder: vscode.WorkspaceFolder,
    ): Promise<void> => {
        const key = folder.uri.toString();
        const forgetPanel = () => {
            if (panels.get(key) === panel) panels.delete(key);
        };
        panels.set(key, panel);
        panel.onDidDispose(forgetPanel);
        try {
            panel.title = panelTitle(folder);
            await attach(panel, folder);
        } catch (error) {
            if (panels.get(key) === panel) {
                forgetPanel();
                panel.dispose();
            }
            onError(error);
        }
    };
    return [
        window.registerWebviewPanelSerializer(DASHBOARD_VIEW_TYPE, {
            async deserializeWebviewPanel(panel, state) {
                const folder = restoreFolder(fileFolders(), state);
                if (!folder) {
                    panel.dispose();
                    onError(
                        new Error(
                            '保存されたワークスペースが見つからないため、ダッシュボードを復元できません。対象フォルダーでコマンドから開いてください',
                        ),
                    );
                    return;
                }
                if (panels.has(folder.uri.toString())) {
                    panel.dispose();
                    return;
                }
                await attachPanel(panel, folder);
            },
        }),
        registerCommand(OPEN_DASHBOARD_COMMAND, async () => {
            try {
                const selected = await chooseFolder();
                const folder =
                    selected &&
                    fileFolders().find(
                        (folder) =>
                            folder.uri.toString() === selected.uri.toString(),
                    );
                if (!folder) return;
                const existing = panels.get(folder.uri.toString());
                if (existing) {
                    existing.reveal();
                    return;
                }
                await attachPanel(
                    window.createWebviewPanel(
                        DASHBOARD_VIEW_TYPE,
                        panelTitle(folder),
                        column,
                        {
                            enableScripts: true,
                            retainContextWhenHidden: true,
                        },
                    ),
                    folder,
                );
            } catch (error) {
                onError(error);
            }
        }),
    ];
}
