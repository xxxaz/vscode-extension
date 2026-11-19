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
        'file:///workspace/監督',
    ),
    { runScripts: 'outside-only', pretendToBeVisual: true },
);
using _cleanup = {
    [Symbol.dispose]() {
        dom.window.close();
    },
};
const messages: BoardMessage[] = [];
let saved: unknown = {
    version: 1,
    query: '配布',
    cards: { T1: true },
    sections: { tasks: true },
    scrollTop: 120,
};
Object.assign(dom.window, {
    acquireVsCodeApi: () => ({
        getState: () => saved,
        setState: (value: unknown) => {
            saved = value;
        },
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
assert.equal(
    dom.window.document.querySelector<HTMLDetailsElement>('[data-card-id="T1"]')
        ?.open,
    true,
);
assert.equal(
    dom.window.document.querySelector<HTMLInputElement>('.filter')?.value,
    '配布',
);
assert.equal(
    (saved as { workspaceUri: string }).workspaceUri,
    'file:///workspace/監督',
);
const filter = dom.window.document.querySelector<HTMLInputElement>('.filter');
assert.ok(filter);
filter.value = '配布JS';
filter.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
assert.equal(
    (saved as { workspaceUri: string }).workspaceUri,
    'file:///workspace/監督',
);
const restored = new JSDOM(
    boardHtml(
        'https://preview.invalid',
        'smoke',
        'https://preview.invalid/dashboard.js',
        'file:///workspace/監督',
    ),
    { runScripts: 'outside-only', pretendToBeVisual: true },
);
try {
    Object.assign(restored.window, {
        acquireVsCodeApi: () => ({
            getState: () => saved,
            setState: (value: unknown) => {
                saved = value;
            },
            postMessage: () => {},
        }),
    });
    restored.window.eval(
        await readFile(
            new URL('../dist/dashboard.js', import.meta.url),
            'utf8',
        ),
    );
    restored.window.dispatchEvent(
        new restored.window.MessageEvent('message', {
            data: { type: 'snapshot', snapshot },
        }),
    );
    assert.equal(
        restored.window.document.querySelector<HTMLInputElement>('.filter')
            ?.value,
        '配布JS',
    );
    assert.equal(
        restored.window.document.querySelector<HTMLDetailsElement>(
            '[data-card-id="T1"]',
        )?.open,
        true,
    );
    assert.equal(
        (saved as { workspaceUri: string }).workspaceUri,
        'file:///workspace/監督',
    );
} finally {
    restored.window.close();
}
console.log(
    '配布HTML/JSの一覧表示と、復元用ルート・検索・展開の保存が成功しました',
);
