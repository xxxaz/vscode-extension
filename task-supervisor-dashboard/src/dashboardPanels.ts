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
    if (
        !state ||
        typeof state !== 'object' ||
        Array.isArray(state) ||
        !('workspaceUri' in state) ||
        typeof state.workspaceUri !== 'string'
    )
        return;
    return folders.find(
        (folder) => folder.uri.toString() === state.workspaceUri,
    );
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
    const panels = new Map<
        string,
        { panel: vscode.WebviewPanel; restored: boolean }
    >();
    const fileFolders = () =>
        folders().filter((folder) => folder.uri.scheme === 'file');
    const attachPanel = async (
        panel: vscode.WebviewPanel,
        folder: vscode.WorkspaceFolder,
        restored: boolean,
    ): Promise<void> => {
        const key = folder.uri.toString();
        const previous = panels.get(key);
        const entry = { panel, restored };
        const forgetPanel = () => {
            if (panels.get(key) === entry) panels.delete(key);
        };
        panels.set(key, entry);
        panel.onDidDispose(forgetPanel);
        previous?.panel.dispose();
        try {
            panel.title = panelTitle(folder);
            await attach(panel, folder);
        } catch (error) {
            if (panels.get(key) !== entry) return;
            forgetPanel();
            panel.dispose();
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
                if (panels.get(folder.uri.toString())?.restored) {
                    panel.dispose();
                    return;
                }
                await attachPanel(panel, folder, true);
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
                    existing.panel.reveal();
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
                    false,
                );
            } catch (error) {
                onError(error);
            }
        }),
    ];
}
