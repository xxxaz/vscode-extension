import { mountBoard } from '../src/dashboardClient.ts';
import type { BoardMessage, BoardSnapshot } from '../src/dashboardTypes.ts';

declare global {
    interface Window {
        __initialBoard: BoardSnapshot;
        __messages: BoardMessage[];
        __boardUpdate(snapshot: BoardSnapshot): void;
    }
}

const host = document.getElementById('board');
if (!host) throw new Error('プレビューの表示領域がありません');
let current = window.__initialBoard;
const storageKey = `task-supervisor-preview:${current.workspace ?? 'sample'}`;
const state = {
    getState(): unknown {
        try {
            return JSON.parse(localStorage.getItem(storageKey) ?? 'null');
        } catch {
            return undefined;
        }
    },
    setState(value: unknown): void {
        try {
            localStorage.setItem(storageKey, JSON.stringify(value));
        } catch {
            console.warn(
                'プレビューの表示状態をブラウザへ保存できませんでした',
            );
        }
    },
};
window.__messages = [];
let board: ReturnType<typeof mountBoard> | undefined;
board = mountBoard(
    host,
    (message) => {
        window.__messages.push(message);
        if (message.type === 'refresh') {
            board?.update({ type: 'snapshot', snapshot: current });
            const failed = current.userActions?.status === 'unavailable';
            board?.update({
                type: 'status',
                failed,
                state: failed ? 'error' : 'info',
                message: failed
                    ? '依頼一覧を取得できていません。'
                    : 'プレビューを更新しました。台帳は変更していません。',
            });
        } else if (message.type === 'operation') {
            board?.update({
                type: 'status',
                state: 'info',
                message: `プレビュー: ${message.id} の操作を確認しました。台帳には記録していません。`,
            });
        } else if (message.type === 'open') {
            board?.update({
                type: 'status',
                state: 'info',
                message:
                    'プレビュー: リンクの選択を確認しました。ファイルや外部サイトは開きません。',
            });
        }
    },
    state,
);
window.__boardUpdate = (next) => {
    current = next;
    board?.update({ type: 'snapshot', snapshot: next });
};
window.__boardUpdate(current);
window.addEventListener('pagehide', () => board?.dispose(), { once: true });
