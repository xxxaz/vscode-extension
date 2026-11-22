import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { mountBoard } from '../src/dashboardClient.ts';
import type {
    BoardCard,
    BoardLink,
    BoardMessage,
    BoardSnapshot,
} from '../src/dashboardTypes.ts';
import { boardHtml } from '../src/dashboardWebview.ts';

const link = (
    id: string,
    kind: 'external' | 'file' | 'task' = 'file',
): BoardLink => ({
    id,
    label: `資料 ${id}`,
    target:
        kind === 'task'
            ? { kind, id }
            : kind === 'file'
              ? { kind, path: '/workspace/資料.md' }
              : { kind, uri: 'https://example.com' },
});
const card = (id = 'U1'): BoardCard => ({
    id,
    title: '依頼の要約',
    summary: '対象・状態を確認して実行',
    badge: 'P1 未実行',
    fields: [
        {
            label: '依頼の全文',
            parts: [{ text: '全文の行1\n行2 <img src=x onerror=alert(1)>' }],
        },
        {
            label: 'コマンド',
            pre: true,
            parts: [{ text: 'echo 確認\n長い引数を省略せず表示', code: true }],
        },
        { label: '状態・理由', parts: [{ text: '未実行 / 確認必要' }] },
        {
            label: '関連タスク',
            parts: [{ text: 'T1へ', link: link('T1', 'task') }],
        },
        { label: '資料', parts: [{ text: '原本', link: link('inline') }] },
        { label: '備考', parts: [] },
    ],
    links: [link('file'), link('external', 'external')],
    operations: [
        {
            operation: 'complete',
            id,
            revision: 'revision-1',
            label: '完了を記録',
        },
        { operation: 'ran', id, revision: 'revision-1', label: 'キック済み' },
    ],
});
const snapshot = (cards: BoardCard[] = [card()]): BoardSnapshot => ({
    schemaVersion: 1,
    source: 'legacy',
    updatedAt: 1795096800000,
    workspace: '/workspace/監督',
    counts: [{ label: '実行', value: cards.length, section: 'execution' }],
    supervisor: link('supervisor'),
    warnings: [],
    sections: [
        {
            id: 'execution',
            title: '実行依頼',
            description: '優先度順に確認',
            defaultOpen: true,
            cards,
        },
        {
            id: 'tasks',
            title: '進行中タスク',
            defaultOpen: true,
            cards: [
                {
                    id: 'T1',
                    title: 'タスクの全文',
                    summary: '実装中',
                    fields: [],
                    links: [],
                    operations: [],
                },
            ],
        },
    ],
});

const readyView = (
    viewVersion: string,
    fetchedAt: number,
): NonNullable<BoardSnapshot['userActions']> => ({
    status: 'ready',
    viewVersion,
    source: { mode: 'legacy', epoch: null, fetchedAt, error: null },
});
function setup(saved?: unknown) {
    const dom = new JSDOM('<!doctype html><div id="host"></div>', {
        pretendToBeVisual: true,
    });
    const host = dom.window.document.querySelector<HTMLElement>('#host')!;
    const messages: BoardMessage[] = [];
    let stored = saved;
    const state = {
        getState: () => stored,
        setState: (value: unknown) => {
            stored = value;
        },
    };
    const mounted = mountBoard(
        host,
        (message) => messages.push(message),
        state,
    );
    const update = (value = snapshot()) =>
        mounted.update({ type: 'snapshot', snapshot: value });
    const click = (selector: string) =>
        host.querySelector<HTMLButtonElement>(selector)!.click();
    const row = (id: string) =>
        Array.from(host.querySelectorAll<HTMLDetailsElement>('.card')).find(
            (node) => node.dataset.cardId === id,
        )!;
    const close = () => {
        mounted.dispose();
        dom.window.close();
    };
    return { dom, host, mounted, update, messages, click, row, state, close };
}

test('旧正本のshadow読取りから常駐部の稼働を推定して表示しない', () => {
    const app = setup();
    try {
        app.update({
            ...snapshot(),
            source: 'shadow',
            userActions: {
                ...readyView('read-1', 12),
                source: {
                    mode: 'shadow',
                    epoch: null,
                    fetchedAt: 12,
                    error: null,
                },
            },
        });
        assert.match(app.host.textContent!, /切替前の台帳/);
        assert.doesNotMatch(app.host.textContent!, /常駐部の並行運転/);
    } finally {
        app.close();
    }
});

test('一覧は全項目・コマンド・件数・監督・対象ルートを省略せず文字として表示する', () => {
    const app = setup();
    try {
        app.update();
        assert.deepEqual(app.messages, [{ type: 'ready' }]);
        assert.match(
            app.host.textContent!,
            /更新.*監督台帳.*\/workspace\/監督/,
        );
        assert.match(app.host.textContent!, /実行 1件/);
        assert.match(app.host.textContent!, /監督: 資料 supervisor/);
        assert.equal(app.row('U1').querySelectorAll('dt').length, 6);
        for (const field of card().fields) {
            assert.ok(app.row('U1').textContent!.includes(field.label));
            for (const part of field.parts)
                assert.ok(app.row('U1').textContent!.includes(part.text));
        }
        assert.match(
            app.row('U1').querySelector('pre')!.textContent!,
            /確認\n長い引数/,
        );
        assert.equal(app.host.querySelectorAll('img,script,a[href]').length, 0);
        app.click('.refresh');
        assert.deepEqual(app.messages.at(-1), { type: 'refresh' });
    } finally {
        app.close();
    }
});

test('差分更新は未変更行と詳細のDOM・開閉・スクロール・フォーカスを保持する', () => {
    const app = setup();
    try {
        app.update(snapshot([card(), card('U2')]));
        const unchanged = app.row('U2');
        const unchangedBody = unchanged.querySelector('.card-body');
        const changed = app.row('U1');
        changed.open = true;
        const inline =
            changed.querySelector<HTMLButtonElement>('.field .text-link')!;
        inline.focus();
        const pre = changed.querySelector('pre')!;
        pre.scrollTop = 32;
        pre.scrollLeft = 5;
        app.host.scrollTop = 250;
        app.update(
            snapshot([
                {
                    ...card(),
                    title: '新しい要約',
                    fields: card().fields.map((field, index) =>
                        index === 2
                            ? { ...field, parts: [{ text: '確認済み' }] }
                            : field,
                    ),
                },
                card('U2'),
            ]),
        );
        assert.equal(app.row('U2'), unchanged);
        assert.equal(app.row('U2').querySelector('.card-body'), unchangedBody);
        assert.equal(app.row('U1'), changed);
        assert.equal(changed.open, true);
        assert.equal(changed.querySelector('pre'), pre);
        assert.equal(pre.scrollTop, 32);
        assert.equal(pre.scrollLeft, 5);
        assert.equal(app.host.scrollTop, 250);
        assert.equal(app.dom.window.document.activeElement, inline);
        assert.match(changed.textContent!, /新しい要約/);
        assert.match(changed.textContent!, /確認済み/);
    } finally {
        app.close();
    }
});

test('追加・並べ替え・削除でも既存カードを使い、操作の版は更新する', () => {
    const app = setup();
    try {
        app.update(snapshot([card(), card('U2')]));
        const first = app.row('U1');
        const second = app.row('U2');
        first.open = true;
        first.querySelector<HTMLButtonElement>('.operation')!.focus();
        const nextCard = card();
        nextCard.operations[0].revision = 'revision-2';
        app.update(snapshot([card('U3'), card('U2'), nextCard]));
        assert.equal(app.row('U1'), first);
        assert.equal(app.row('U2'), second);
        assert.equal(first.open, true);
        assert.equal(
            app.dom.window.document.activeElement,
            first.querySelector('.operation'),
        );
        const ids = Array.from(app.host.querySelectorAll('.card')).map(
            (node) => (node as HTMLElement).dataset.cardId,
        );
        assert.deepEqual(ids, ['U3', 'U2', 'U1', 'T1']);
        app.row('U1').querySelector<HTMLButtonElement>('.operation')!.click();
        assert.deepEqual(app.messages.at(-1), {
            type: 'operation',
            operation: 'complete',
            id: 'U1',
            revision: 'revision-2',
        });
        app.update(snapshot([card('U2')]));
        assert.equal(first.isConnected, false);
        assert.equal(app.row('U2'), second);
    } finally {
        app.close();
    }
});

test('入力・開閉・スクロールを保存し再マウントで復帰する', () => {
    const app = setup();
    try {
        app.update();
        app.row('U1').open = true;
        app.row('U1').dispatchEvent(new app.dom.window.Event('toggle'));
        const section = app.host.querySelector<HTMLDetailsElement>(
            '[data-section-id="tasks"]',
        )!;
        section.open = false;
        section.dispatchEvent(new app.dom.window.Event('toggle'));
        const input = app.host.querySelector<HTMLInputElement>('input')!;
        input.value = 'U1';
        input.dispatchEvent(new app.dom.window.Event('input'));
        app.host.scrollTop = 123;
        app.host.dispatchEvent(new app.dom.window.Event('scroll'));
        app.mounted.dispose();
        const restored = mountBoard(
            app.host,
            (message) => app.messages.push(message),
            app.state,
        );
        restored.update({ type: 'snapshot', snapshot: snapshot() });
        assert.equal(
            app.host.querySelector<HTMLInputElement>('input')!.value,
            'U1',
        );
        assert.equal(app.row('U1').open, true);
        assert.equal(
            app.host.querySelector<HTMLDetailsElement>(
                '[data-section-id="tasks"]',
            )!.open,
            false,
        );
        assert.equal(app.host.scrollTop, 123);
        assert.equal(app.row('T1').hidden, true);
        restored.dispose();
    } finally {
        app.close();
    }
});

test('リンクは許可されたIDだけを送り、タスクリンクは一覧を展開して移動する', () => {
    const app = setup();
    try {
        app.update();
        const buttons = app
            .row('U1')
            .querySelectorAll<HTMLButtonElement>('.card-links button');
        buttons[0].click();
        buttons[1].click();
        assert.deepEqual(app.messages.slice(-2), [
            { type: 'open', linkId: 'file' },
            { type: 'open', linkId: 'external' },
        ]);
        const filter = app.host.querySelector<HTMLInputElement>('input')!;
        filter.value = 'U1';
        filter.dispatchEvent(new app.dom.window.Event('input'));
        app.row('U1')
            .querySelector<HTMLButtonElement>('.field .text-link')!
            .click();
        assert.equal(app.row('T1').hidden, false);
        assert.equal(app.row('T1').open, true);
        assert.equal(filter.value, '');
        assert.equal(
            app.dom.window.document.activeElement,
            app.row('T1').querySelector('summary'),
        );
        assert.equal(app.messages.length, 3);
        const forged = app.dom.window.document.createElement('button');
        forged.dataset.operation = 'delete';
        app.host.querySelector('main')!.append(forged);
        forged.click();
        assert.equal(app.messages.length, 3);
        app.click('.count-link');
        assert.equal(
            app.host.querySelector<HTMLDetailsElement>(
                '[data-section-id="execution"]',
            )!.open,
            true,
        );
    } finally {
        app.close();
    }
});

test('操作は列挙値・正確なIDと版に限定し連打を抑止、処理中・結果待ち・成功・失敗を区別する', () => {
    const app = setup();
    try {
        const item = card();
        item.operations.push({
            operation: 'delete' as 'complete',
            id: 'U1',
            revision: 'x',
            label: '不正操作',
        });
        app.update(snapshot([item]));
        assert.equal(app.row('U1').querySelectorAll('.operation').length, 2);
        app.click('.operation');
        app.click('.operation');
        assert.equal(
            app.messages.filter((message) => message.type === 'operation')
                .length,
            1,
        );
        assert.equal(
            app.host.querySelector('.status')!.getAttribute('data-state'),
            'busy',
        );
        assert.ok(
            Array.from(
                app.host.querySelectorAll<HTMLButtonElement>('.operation'),
            ).every((button) => button.disabled),
        );
        app.mounted.update({
            type: 'status',
            message: '受付済み・適用結果待ち',
            state: 'pending',
        });
        assert.equal(
            app.host.querySelector('.status')!.getAttribute('data-state'),
            'pending',
        );
        assert.equal(
            app.host.querySelector<HTMLButtonElement>('.operation')!.disabled,
            false,
        );
        app.mounted.update({
            type: 'status',
            message: '保存しました',
            state: 'success',
        });
        assert.equal(
            app.host.querySelector('.status')!.getAttribute('data-state'),
            'success',
        );
        app.mounted.update({
            type: 'status',
            message: '読取り失敗',
            failed: true,
        });
        assert.equal(
            app.host.querySelector('.status')!.getAttribute('data-state'),
            'failed',
        );
        assert.equal(
            app.host.querySelector('.status')!.getAttribute('aria-live'),
            'polite',
        );
        assert.equal(app.row('U1').isConnected, true);
    } finally {
        app.close();
    }
});

test('警告・空・検索0件・削除を明示し、破棄後はイベントと更新を受けない', () => {
    const app = setup({
        version: 1,
        query: '',
        sections: null,
        cards: 2,
        scrollTop: -5,
    });
    try {
        const empty = snapshot([]);
        empty.warnings = ['原票の一部を読めません'];
        empty.sections = [empty.sections[0]];
        app.update(empty);
        assert.equal(
            app.host.querySelector<HTMLElement>('.warnings')!.hidden,
            false,
        );
        assert.match(
            app.host.querySelector('.warnings')!.textContent!,
            /読めません/,
        );
        assert.match(app.host.textContent!, /表示する項目はありません/);
        app.update();
        assert.equal(
            app.host.querySelector<HTMLElement>('.warnings')!.hidden,
            true,
        );
        const filter = app.host.querySelector<HTMLInputElement>('input')!;
        filter.value = '存在しない';
        filter.dispatchEvent(new app.dom.window.Event('input'));
        assert.match(
            app.host.querySelector('.board-empty')!.textContent!,
            /検索に一致/,
        );
        const refresh = app.host.querySelector<HTMLButtonElement>('.refresh')!;
        app.mounted.dispose();
        const count = app.messages.length;
        refresh.click();
        app.update();
        assert.equal(app.messages.length, count);
        assert.equal(app.host.children.length, 0);
    } finally {
        app.close();
    }
});

test('Webviewはnonce付きのCSSとscriptだけを許可しHTML属性をエスケープする', () => {
    const html = boardHtml(
        'vscode-webview://unit',
        'safe-nonce',
        'vscode-webview://unit/client.js',
    );
    const dom = new JSDOM(html);
    try {
        const csp = dom.window.document
            .querySelector('meta[http-equiv="Content-Security-Policy"]')!
            .getAttribute('content')!;
        assert.match(csp, /default-src 'none'/);
        assert.match(csp, /script-src 'nonce-safe-nonce'/);
        assert.match(csp, /style-src 'nonce-safe-nonce'/);
        assert.match(csp, /connect-src 'none'/);
        assert.equal(dom.window.document.querySelectorAll('script').length, 1);
        assert.equal(
            dom.window.document.querySelector('style')!.getAttribute('nonce'),
            'safe-nonce',
        );
        assert.match(
            dom.window.document.querySelector('style')!.textContent!,
            /white-space: pre-wrap/,
        );
        assert.match(
            dom.window.document.querySelector('style')!.textContent!,
            /--vscode-editor-background/,
        );
    } finally {
        dom.window.close();
    }
    const unsafe = new JSDOM(
        boardHtml(
            'x" onload="bad',
            'x" onload="bad',
            'x"><img src=x onerror=bad>',
            'file:///x"><img src=x onerror=bad>',
        ),
    );
    try {
        assert.equal(
            unsafe.window.document.getElementById('board')?.dataset
                .workspaceUri,
            'file:///x"><img src=x onerror=bad>',
        );
        assert.equal(
            unsafe.window.document.querySelectorAll('img,[onload],[onerror]')
                .length,
            0,
        );
    } finally {
        unsafe.window.close();
    }
});

test('カードの要約が見出しと同じ場合だけ重複行を隠し、全文とDOM・フォーカスを保持する', () => {
    const app = setup();
    try {
        const duplicate = {
            ...card(),
            title: '依頼の要約',
            summary: '  依頼の要約\n',
        };
        app.update(snapshot([duplicate]));
        const row = app.row('U1');
        row.open = true;
        const excerpt = row.querySelector<HTMLElement>('.card-excerpt')!;
        const field = row.querySelector('.fields');
        const button = row.querySelector<HTMLButtonElement>('.operation')!;
        button.focus();
        assert.equal(excerpt.hidden, true);
        assert.ok(field!.textContent!.includes(card().fields[0].parts[0].text));
        app.update(
            snapshot([{ ...duplicate, summary: '担当者の結果確認待ち' }]),
        );
        assert.equal(app.row('U1'), row);
        assert.equal(row.querySelector('.card-excerpt'), excerpt);
        assert.equal(excerpt.hidden, false);
        assert.equal(excerpt.textContent, '担当者の結果確認待ち');
        assert.equal(row.querySelector('.fields'), field);
        assert.equal(row.open, true);
        assert.equal(app.dom.window.document.activeElement, button);
        app.update(snapshot([{ ...duplicate, summary: ' ' }]));
        assert.equal(excerpt.hidden, true);
        assert.equal(app.dom.window.document.activeElement, button);
    } finally {
        app.close();
    }
});

test('通知と出来事の内部IDは非表示にし、U・T番号と更新用の識別子は維持する', () => {
    const app = setup();
    try {
        const ids = [
            'U1',
            'U12AB',
            'T42',
            `notice:${'a'.repeat(64)}`,
            'event:3:123456',
            'task:T99',
        ];
        app.update(snapshot(ids.map((id) => card(id))));
        for (const [index, id] of ids.entries()) {
            const row = app.row(id);
            assert.equal(row.dataset.cardId, id);
            assert.equal(
                row.querySelector<HTMLElement>('.card-id')!.hidden,
                index >= 3,
            );
            assert.equal(
                row.querySelector('.card-title')!.textContent,
                '依頼の要約',
            );
        }
        const notice = app.row(ids[3]);
        notice.open = true;
        const summary = notice.querySelector<HTMLElement>('summary')!;
        summary.focus();
        app.update(
            snapshot(
                ids.map((id) => ({ ...card(id), title: '更新後の見出し' })),
            ),
        );
        assert.equal(app.row(ids[3]), notice);
        assert.equal(notice.open, true);
        assert.equal(app.dom.window.document.activeElement, summary);
        assert.equal(
            notice.querySelector<HTMLElement>('.card-id')!.hidden,
            true,
        );
    } finally {
        app.close();
    }
});

test('取得した版が変わりカードが結果待ちへ移ってもDOM・開閉・検索・フォーカスとスクロールを保つ', () => {
    const app = setup();
    const moved = (destination: string, item = card()): BoardSnapshot => ({
        ...snapshot([]),
        userActions: readyView(`view-${destination}`, 1795096801000),
        sections: ['execution', 'awaiting', 'held'].map((id) => ({
            id,
            title: id,
            defaultOpen: id !== 'held',
            cards: id === destination ? [item] : [],
        })),
    });
    try {
        app.update(moved('execution'));
        const original = app.row('U1');
        original.open = true;
        const button = original.querySelector<HTMLButtonElement>('.operation')!;
        const filter = app.host.querySelector<HTMLInputElement>('input')!;
        filter.value = '対象・状態';
        filter.dispatchEvent(new app.dom.window.Event('input'));
        button.focus();
        const field = original.querySelector('.fields');
        const pre = original.querySelector('pre')!;
        pre.scrollTop = 24;
        app.host.scrollTop = 180;
        app.update(
            moved('awaiting', {
                ...card(),
                title: '依頼の更新後の要約',
                badge: '結果確認待ち',
                operations: [card().operations[0]],
            }),
        );
        assert.equal(app.row('U1'), original);
        assert.equal(
            original.closest<HTMLElement>('.board-section')!.dataset.sectionId,
            'awaiting',
        );
        assert.equal(original.querySelector('.fields'), field);
        assert.equal(original.open, true);
        assert.equal(filter.value, '対象・状態');
        assert.equal(original.hidden, false);
        assert.match(original.textContent!, /依頼の更新後の要約/);
        assert.match(
            app.host.querySelector('.metadata')!.textContent!,
            /依頼一覧の版 view-awaiting/,
        );
        assert.equal(app.dom.window.document.activeElement, button);
        assert.equal(pre.scrollTop, 24);
        assert.equal(app.host.scrollTop, 180);
        assert.equal(
            app.host.querySelector('[data-section-id="execution"] .card'),
            null,
        );
        assert.equal(
            app.host.querySelectorAll('[data-card-id="U1"]').length,
            1,
        );
        const summary = original.querySelector<HTMLElement>('summary')!;
        summary.focus();
        const backwards = moved('execution');
        backwards.sections.reverse();
        app.update(backwards);
        assert.equal(app.row('U1'), original);
        assert.equal(app.dom.window.document.activeElement, summary);
        assert.equal(original.open, true);
        app.host.querySelector<HTMLButtonElement>('.refresh')!.focus();
        app.update(moved('held'));
        assert.equal(app.row('U1'), original);
        assert.equal(original.open, true);
        assert.equal(
            app.host.querySelector<HTMLDetailsElement>(
                '[data-section-id="held"]',
            )!.open,
            false,
        );
    } finally {
        app.close();
    }
});

test('読取りの初回失敗を空一覧から区別し、正常な空一覧を取得すると失敗表示を解除する', () => {
    const app = setup();
    try {
        const empty = app.host.querySelector<HTMLElement>('.board-empty')!;
        const status = app.host.querySelector<HTMLElement>('.status')!;
        const filter = app.host.querySelector<HTMLInputElement>('input')!;
        filter.dispatchEvent(new app.dom.window.Event('input'));
        assert.equal(empty.hidden, true);
        app.mounted.update({
            type: 'status',
            message: '依頼一覧を取得できません',
            failed: true,
            state: 'error',
        });
        assert.equal(status.hidden, false);
        assert.match(status.textContent!, /取得できません/);
        assert.equal(empty.hidden, true);

        app.update({
            ...snapshot([]),
            sections: [],
            userActions: readyView('empty-view', 1795096801000),
        });
        assert.equal(status.hidden, true);
        assert.equal(empty.hidden, false);
        assert.match(empty.textContent!, /表示する項目はありません/);
    } finally {
        app.close();
    }
});

test('取得不能中は前回の一覧と取得時点を保持し、行操作は復旧まで無効にする', () => {
    const app = setup();
    try {
        const fetchedAt = 1795096801000;
        const initial = {
            ...snapshot(),
            userActions: readyView('ready-view', fetchedAt),
        };
        app.update(initial);
        const row = app.row('U1');
        row.open = true;
        const section = row.closest('.board-section');
        const button = row.querySelector<HTMLButtonElement>('.operation')!;
        const metadata = app.host.querySelector('.metadata')!;
        const updateTime = new Date(initial.updatedAt).toLocaleString('ja-JP');
        const fetchTime = new Date(fetchedAt).toLocaleString('ja-JP');
        assert.ok(metadata.textContent!.includes(`取得時点 ${fetchTime}`));
        const filter = app.host.querySelector<HTMLInputElement>('input')!;
        filter.value = 'U1';
        filter.dispatchEvent(new app.dom.window.Event('input'));
        app.host.scrollTop = 180;
        app.update({
            ...initial,
            userActions: {
                status: 'unavailable',
                viewVersion: 'unavailable-view',
                source: {
                    mode: 'authoritative',
                    epoch: 'runtime-epoch',
                    fetchedAt: null,
                    error: {
                        code: 'runtime-stopped',
                        message: '常駐部の停止を検出しました',
                    },
                },
                lastSuccessful: { viewVersion: 'ready-view', fetchedAt },
            },
            warnings: ['常駐部の停止を検出しました'],
        });
        assert.equal(app.row('U1'), row);
        assert.equal(row.closest('.board-section'), section);
        assert.equal(row.open, true);
        assert.equal(row.querySelector('.operation'), button);
        assert.equal(filter.value, 'U1');
        assert.equal(app.host.scrollTop, 180);
        assert.match(metadata.textContent!, /依頼一覧の版 unavailable-view/);
        assert.match(metadata.textContent!, /取得失敗.*runtime-stopped/);
        assert.ok(metadata.textContent!.includes(`更新 ${updateTime}`));
        assert.ok(
            metadata.textContent!.includes(
                `前回正常取得 ${fetchTime}（版 ready-view）`,
            ),
        );
        assert.match(
            app.host.querySelector('.warnings')!.textContent!,
            /常駐部の停止/,
        );
        app.mounted.update({ type: 'status', message: '', busy: false });
        assert.equal(button.disabled, true);
        button.dispatchEvent(
            new app.dom.window.MouseEvent('click', { bubbles: true }),
        );
        assert.deepEqual(app.messages, [{ type: 'ready' }]);

        app.update({
            ...initial,
            userActions: readyView('recovered-view', fetchedAt + 1000),
        });
        assert.equal(app.row('U1'), row);
        assert.equal(row.open, true);
        assert.equal(filter.value, 'U1');
        assert.equal(app.host.scrollTop, 180);
        assert.equal(button.disabled, false);
        assert.match(metadata.textContent!, /依頼一覧の版 recovered-view/);
        assert.doesNotMatch(metadata.textContent!, /取得失敗|前回正常取得/);
        button.click();
        assert.deepEqual(app.messages.at(-1), {
            type: 'operation',
            operation: 'complete',
            id: 'U1',
            revision: 'revision-1',
        });
    } finally {
        app.close();
    }
});

test('移動元の区分が消えてもカードを引き継ぎ、消えたカードは破棄して再追加時に作り直す', () => {
    const app = setup();
    try {
        app.update();
        const original = app.row('U1');
        original.open = true;
        const summary = original.querySelector<HTMLElement>('summary')!;
        summary.focus();
        const transferred = {
            ...snapshot([]),
            sections: [
                {
                    id: 'awaiting',
                    title: '結果確認待ち',
                    defaultOpen: true,
                    cards: [card()],
                },
            ],
        };
        app.update(transferred);
        assert.equal(app.row('U1'), original);
        assert.equal(app.dom.window.document.activeElement, summary);
        assert.equal(original.open, true);
        app.update({ ...transferred, sections: [] });
        assert.equal(original.isConnected, false);
        app.update(transferred);
        assert.notEqual(app.row('U1'), original);
        assert.equal(app.row('U1').open, false);
    } finally {
        app.close();
    }
});

test('カードの開閉を区分に依存せず保存し、旧区分付きキーも移動先で復帰する', () => {
    const app = setup({
        version: 1,
        query: '',
        sections: { held: false },
        cards: { '["execution","U1"]': true },
        scrollTop: 0,
    });
    try {
        const transferred = {
            ...snapshot([]),
            sections: [
                {
                    id: 'awaiting',
                    title: '結果確認待ち',
                    defaultOpen: true,
                    cards: [card()],
                },
                { id: 'held', title: '保留', defaultOpen: true, cards: [] },
            ],
        };
        app.update(transferred);
        assert.equal(app.row('U1').open, true);
        app.row('U1').dispatchEvent(new app.dom.window.Event('toggle'));
        const stored = app.state.getState() as {
            cards: Record<string, boolean>;
        };
        assert.deepEqual(stored.cards, { U1: true });
        app.mounted.dispose();
        const restored = mountBoard(
            app.host,
            (message) => app.messages.push(message),
            app.state,
        );
        restored.update({
            type: 'snapshot',
            snapshot: {
                ...transferred,
                sections: [
                    { ...transferred.sections[0], cards: [] },
                    { ...transferred.sections[1], cards: [card()] },
                ],
            },
        });
        assert.equal(app.row('U1').open, true);
        assert.equal(
            app.host.querySelector<HTMLDetailsElement>(
                '[data-section-id="held"]',
            )!.open,
            false,
        );
        restored.dispose();
    } finally {
        app.close();
    }
});

for (const reverse of [false, true]) {
    test(`フォーカス中のカードが閉じた完了区分へ移ったときだけ移動先を開く（逆順=${reverse}）`, () => {
        const app = setup();
        const makeSnapshot = (destination: string): BoardSnapshot => {
            const sections = [
                {
                    id: 'tasks',
                    title: '進行中',
                    defaultOpen: true,
                    cards: destination === 'tasks' ? [card('T1')] : [],
                },
                {
                    id: 'completed',
                    title: '完了',
                    defaultOpen: false,
                    cards: destination === 'completed' ? [card('T1')] : [],
                },
                { id: 'held', title: '保留', defaultOpen: false, cards: [] },
            ];
            return {
                ...snapshot([]),
                sections: reverse ? sections.reverse() : sections,
            };
        };
        try {
            app.update(makeSnapshot('tasks'));
            const row = app.row('T1');
            row.open = true;
            const summary = row.querySelector<HTMLElement>('summary')!;
            summary.focus();
            app.update(makeSnapshot('completed'));
            assert.equal(app.row('T1'), row);
            assert.equal(row.open, true);
            assert.equal(
                app.host.querySelector<HTMLDetailsElement>(
                    '[data-section-id="completed"]',
                )!.open,
                true,
            );
            assert.equal(app.dom.window.document.activeElement, summary);
            assert.equal(
                app.host.querySelector<HTMLDetailsElement>(
                    '[data-section-id="held"]',
                )!.open,
                false,
            );
            app.mounted.dispose();
            const restored = mountBoard(app.host, () => {}, app.state);
            restored.update({
                type: 'snapshot',
                snapshot: makeSnapshot('completed'),
            });
            assert.equal(
                app.host.querySelector<HTMLDetailsElement>(
                    '[data-section-id="completed"]',
                )!.open,
                true,
            );
            restored.dispose();
        } finally {
            app.close();
        }
    });
}

test('フォーカスのないカードの移動や区分内更新では閉じた区分を開かない', () => {
    const app = setup();
    try {
        const next = {
            ...snapshot([card()]),
            sections: [
                {
                    id: 'execution',
                    title: '実行',
                    defaultOpen: true,
                    cards: [card()],
                },
                {
                    id: 'completed',
                    title: '完了',
                    defaultOpen: false,
                    cards: [] as BoardCard[],
                },
                { id: 'held', title: '保留', defaultOpen: false, cards: [] },
            ],
        };
        app.update(next);
        app.row('U1').open = true;
        app.host.querySelector<HTMLButtonElement>('.refresh')!.focus();
        app.update({
            ...next,
            sections: [
                { ...next.sections[0], cards: [] },
                { ...next.sections[1], cards: [card()] },
                next.sections[2],
            ],
        });
        assert.equal(app.row('U1').open, true);
        assert.equal(
            app.host.querySelector<HTMLDetailsElement>(
                '[data-section-id="completed"]',
            )!.open,
            false,
        );
        assert.equal(
            app.host.querySelector<HTMLDetailsElement>(
                '[data-section-id="held"]',
            )!.open,
            false,
        );
        assert.equal(
            app.dom.window.document.activeElement,
            app.host.querySelector('.refresh'),
        );
    } finally {
        app.close();
    }
});

test('詳細の各項目をspan・code・リンクごとに別行で表示し、原文・リンク・DOMを保持する', () => {
    const dom = new JSDOM(
        boardHtml('vscode-webview://unit', 'test-nonce', 'preview.js'),
        { pretendToBeVisual: true },
    );
    const host = dom.window.document.getElementById('board')!;
    const messages: BoardMessage[] = [];
    const board = mountBoard(host, (message) => messages.push(message));
    try {
        const item = {
            ...card(),
            fields: [
                {
                    label: 'ステータス',
                    parts: [
                        { text: '作業中' },
                        { text: 'feature/preview', code: true },
                        { text: '判断資料', link: link('reference') },
                    ],
                },
                {
                    label: 'コマンド',
                    pre: true,
                    parts: [
                        {
                            text: 'node verify.ts\n  --long-option=value',
                            code: true,
                        },
                    ],
                },
            ],
        };
        board.update({ type: 'snapshot', snapshot: snapshot([item]) });
        const values = host.querySelectorAll<HTMLElement>('.field-value');
        const parts = Array.from(values[0].children);
        assert.deepEqual(
            parts.map((part) => part.tagName),
            ['SPAN', 'CODE', 'BUTTON'],
        );
        for (const part of parts)
            assert.equal(dom.window.getComputedStyle(part).display, 'block');
        assert.equal(dom.window.getComputedStyle(parts[1]).marginTop, '4px');
        assert.equal(dom.window.getComputedStyle(parts[2]).marginTop, '4px');
        assert.equal(
            dom.window.getComputedStyle(values[1]).whiteSpace,
            'pre-wrap',
        );
        assert.equal(values[1].textContent, item.fields[1].parts[0].text);
        (parts[2] as HTMLButtonElement).click();
        assert.deepEqual(messages.at(-1), {
            type: 'open',
            linkId: 'reference',
        });
        board.update({
            type: 'snapshot',
            snapshot: snapshot([{ ...item, summary: '新しい補足' }]),
        });
        for (const [index, part] of parts.entries())
            assert.equal(values[0].children[index], part);
    } finally {
        board.dispose();
        dom.window.close();
    }
});

test('コピーはIDと表示版だけを送り、更新後も同じボタンと開閉を保持する', () => {
    const app = setup();
    try {
        const initial = card();
        initial.command = {
            id: 'U1',
            revision: 'a'.repeat(64),
            text: 'echo 原文',
        };
        app.update(snapshot([initial]));
        app.row('U1').open = true;
        const button =
            app.host.querySelector<HTMLButtonElement>('.copy-command')!;
        button.click();
        assert.deepEqual(app.messages.at(-1), {
            type: 'copy-command',
            id: 'U1',
            revision: 'a'.repeat(64),
        });
        assert.notEqual(app.host.getAttribute('aria-busy'), 'true');
        const changed = {
            ...initial,
            command: {
                ...initial.command,
                revision: 'b'.repeat(64),
                text: 'echo 更新',
            },
        };
        app.update(snapshot([changed]));
        assert.equal(app.host.querySelector('.copy-command'), button);
        assert.equal(app.row('U1').open, true);
        const stopped = snapshot([changed]);
        stopped.userActions = {
            status: 'unavailable',
            viewVersion: 'stopped',
            source: {
                mode: 'legacy',
                epoch: null,
                fetchedAt: null,
                error: { code: 'read-failed', message: '停止' },
            },
        };
        app.update(stopped);
        assert.equal(button.disabled, true);
        const messages = app.messages.length;
        button.click();
        assert.equal(app.messages.length, messages);
        app.update(snapshot([changed]));
        assert.equal(app.host.querySelector('.copy-command'), button);
        assert.equal(button.disabled, false);
        button.click();
        assert.deepEqual(app.messages.at(-1), {
            type: 'copy-command',
            id: 'U1',
            revision: 'b'.repeat(64),
        });
        app.update(snapshot([card()]));
        assert.equal(app.host.querySelector('.copy-command'), null);
    } finally {
        app.close();
    }
});
test('遅いコピーの成功や失敗が記録操作の結果とbusyを上書きしない', () => {
    const app = setup();
    try {
        app.update();
        app.mounted.update({
            type: 'status',
            message: '記録操作のエラー',
            failed: true,
            state: 'error',
        });
        const status = app.host.querySelector('.status:not(.copy-feedback)');
        assert.ok(status);
        app.mounted.update({
            type: 'copy-status',
            id: 'U1',
            message: 'U1 コピー成功',
            failed: false,
            state: 'success',
        });
        assert.equal(status.textContent, '記録操作のエラー');
        assert.equal(status.getAttribute('data-state'), 'failed');
        app.mounted.update({ type: 'status', message: '記録中', busy: true });
        app.mounted.update({
            type: 'copy-status',
            id: 'U2',
            message: 'U2 コピー失敗',
            failed: true,
            state: 'error',
        });
        assert.equal(status.textContent, '記録中');
        assert.equal(
            app.host.querySelector('.board')?.getAttribute('aria-busy'),
            'true',
        );
        assert.equal(
            app.host.querySelector('.copy-feedback')?.textContent,
            'U2 コピー失敗',
        );
    } finally {
        app.close();
    }
});
