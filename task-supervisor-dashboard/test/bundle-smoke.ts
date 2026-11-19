import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import type { BoardMessage, BoardSnapshot } from '../src/dashboardTypes.ts';
import { boardHtml } from '../src/dashboardWebview.ts';

const dom = new JSDOM(
    boardHtml(
        'https://preview.invalid',
        'smoke',
        'https://preview.invalid/dashboard.js',
    ),
    { runScripts: 'outside-only', pretendToBeVisual: true },
);
using _cleanup = {
    [Symbol.dispose]() {
        dom.window.close();
    },
};
const messages: BoardMessage[] = [];
Object.assign(dom.window, {
    acquireVsCodeApi: () => ({
        getState: () => undefined,
        setState: () => {},
        postMessage: (value: BoardMessage) => messages.push(value),
    }),
});
dom.window.eval(
    await readFile(new URL('../dist/dashboard.js', import.meta.url), 'utf8'),
);
assert.ok(
    messages.some((m) => m.type === 'ready'),
    '生成HTMLと配布JSが接続していません',
);
const snapshot: BoardSnapshot = {
    schemaVersion: 1,
    source: 'legacy',
    updatedAt: 1,
    workspace: '配布物の起動検査',
    warnings: [],
    counts: [{ label: '進行中', value: 1, section: 'tasks' }],
    sections: [
        {
            id: 'tasks',
            title: '進行中のタスク',
            defaultOpen: true,
            cards: [
                {
                    id: 'T1',
                    title: '配布JSから一覧を表示',
                    summary: '',
                    fields: [],
                    links: [],
                    operations: [],
                },
            ],
        },
    ],
};
dom.window.dispatchEvent(
    new dom.window.MessageEvent('message', {
        data: { type: 'snapshot', snapshot },
    }),
);
assert.match(
    dom.window.document.body.textContent ?? '',
    /配布JSから一覧を表示/,
);
assert.ok(dom.window.document.querySelector('[data-card-id="T1"]'));
console.log('配布HTMLとバンドルJSの接続・一覧表示が成功しました');
