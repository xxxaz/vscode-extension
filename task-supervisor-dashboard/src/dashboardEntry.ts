import { mountBoard } from './dashboardClient.ts';
import type { BoardMessage, BoardUpdate } from './dashboardTypes.ts';

declare function acquireVsCodeApi(): {
    postMessage(message: BoardMessage): void;
    getState(): unknown;
    setState(value: unknown): void;
};
const api = acquireVsCodeApi();
const host = document.getElementById('board');
if (!host) throw new Error('一覧の表示領域がありません');
const workspaceUri = host.dataset.workspaceUri;
const state = {
    getState: () => api.getState(),
    setState: (value: unknown) =>
        api.setState({
            ...(value && typeof value === 'object' ? value : {}),
            ...(workspaceUri ? { workspaceUri } : {}),
        }),
};
state.setState(api.getState());
const board = mountBoard(host, (message) => api.postMessage(message), state);
window.addEventListener('message', (event) =>
    board.update(event.data as BoardUpdate),
);
window.addEventListener('pagehide', () => board.dispose(), { once: true });
