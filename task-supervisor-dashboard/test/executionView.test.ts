import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import {
    mountExecutionOutput,
    mountExecutionPreview,
    mountResultAccess,
    type ResultAccessView,
} from '../src/executionView.ts';

const tick = async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
};
test('保存済み出力の追加は原文・既存DOM・読みかけのスクロールを保持する', () => {
    const dom = new JSDOM(
        '<style>.field-value > * { display: block; }</style><main></main>',
    );
    using _cleanup = { [Symbol.dispose]: () => dom.window.close() };
    const host = dom.window.document.querySelector('main');
    assert.ok(host);
    const view = mountExecutionOutput(host);
    const output = host.querySelector('pre');
    assert.ok(output);
    Object.defineProperties(output, {
        scrollHeight: { value: 2000 },
        clientHeight: { value: 100 },
    });
    output.scrollTop = 120;
    view.showSaved({
        sequence: 1,
        stream: 'stdout',
        text: '<script>原文</script>\n',
        byteLength: 26,
        sha256: 'fixture',
    });
    const first = output.firstChild;
    const span = output.querySelector('span');
    assert.ok(span);
    assert.equal(dom.window.getComputedStyle(span).display, 'inline');
    assert.equal(host.querySelector('script'), null);
    assert.equal(output.scrollTop, 120);
    view.showSaved({
        sequence: 2,
        stream: 'stderr',
        text: '  stderr\n',
        byteLength: 9,
        sha256: 'fixture',
    });
    assert.equal(output.firstChild, first);
    assert.equal(output.scrollTop, 120);
    output.scrollTop = 1900;
    Array.from(host.querySelectorAll('button'))
        .find((b) => b.textContent === '最新の出力を追う')
        ?.click();
    view.showSaved({
        sequence: 3,
        stream: 'stdout',
        text: '続き',
        byteLength: 6,
        sha256: 'fixture',
    });
    assert.equal(output.scrollTop, 2000);
    view.showSaved({
        sequence: 5,
        stream: 'stdout',
        text: '欠落後',
        byteLength: 9,
        sha256: 'fixture',
    });
    assert.match(host.textContent ?? '', /表示に欠落/);
    view.dispose();
    assert.equal(host.children.length, 0);
});
test('8MiBの全文はUI cacheに保ち、DOMは8片/128KiB以下で先頭・中間・末尾へ移動する', () => {
    const dom = new JSDOM('<main></main>');
    using _cleanup = { [Symbol.dispose]: () => dom.window.close() };
    const host = dom.window.document.querySelector('main');
    assert.ok(host);
    const view = mountExecutionOutput(host),
        output = host.querySelector('pre');
    assert.ok(output);
    const button = (text: string) => {
        const b = Array.from(host.querySelectorAll('button')).find(
            (b) => b.textContent === text,
        );
        assert.ok(b);
        return b;
    };
    const originals: string[] = [];
    const shown = () => Array.from(output.querySelectorAll('span'));
    let reading: Element | undefined;
    for (let i = 1; i <= 512; i++) {
        const prefix = `片${i}:日本語😀`,
            remaining = 16384 - new TextEncoder().encode(prefix).length;
        const text =
            prefix +
            'あ'.repeat(Math.floor(remaining / 3)) +
            'x'.repeat(remaining % 3);
        originals.push(text);
        view.showSaved({
            sequence: i,
            stream: i % 2 ? 'stdout' : 'stderr',
            text,
            byteLength: 16384,
            sha256: 'fixture',
        });
        assert.ok(shown().length <= 8);
        assert.ok(
            new TextEncoder().encode(output.textContent ?? '').length <=
                128 * 1024,
        );
        if (i === 256) {
            button('前の出力').click();
            output.scrollTop = 70;
            reading = shown()[0];
        }
        if (i > 256) {
            assert.equal(shown()[0], reading);
            assert.equal(output.scrollTop, 70);
        }
    }
    button('最新の出力を追う').click();
    assert.equal(shown()[0].dataset.sequence, '505');
    const all = new Map<number, string>();
    for (;;) {
        for (const node of shown())
            all.set(Number(node.dataset.sequence), node.textContent ?? '');
        if (button('前の出力').disabled) break;
        button('前の出力').click();
    }
    assert.equal(all.size, 512);
    assert.equal(
        Array.from({ length: 512 }, (_, i) => all.get(i + 1)).join(''),
        originals.join(''),
    );
    button('次の出力').click();
    assert.equal(shown()[0].dataset.sequence, '9');
    view.dispose();
    assert.equal(output.children.length, 0);
    assert.equal(host.children.length, 0);
});
test('最大4096片でも表示DOMを増やさず、全文を窓の移動で確認できる', () => {
    const dom = new JSDOM('<main></main>');
    using _cleanup = { [Symbol.dispose]: () => dom.window.close() };
    const host = dom.window.document.querySelector('main');
    assert.ok(host);
    const view = mountExecutionOutput(host),
        output = host.querySelector('pre');
    assert.ok(output);
    for (let i = 1; i <= 4096; i++) {
        const text = `${i}:日本語😀\n`;
        view.showSaved({
            sequence: i,
            stream: 'stdout',
            text,
            byteLength: new TextEncoder().encode(text).length,
            sha256: 'fixture',
        });
        assert.ok(output.children.length <= 8);
    }
    assert.equal((output.firstChild as HTMLElement).dataset.sequence, '4089');
    for (let i = 0; i < 256; i++)
        Array.from(host.querySelectorAll('button'))
            .find((b) => b.textContent === '前の出力')
            ?.click();
    assert.equal((output.firstChild as HTMLElement).dataset.sequence, '2041');
    view.dispose();
});
test('固定版の資料・コマンド全文を文字で表示し、未接続と未確認では確定できない', () => {
    const dom = new JSDOM('<main></main>');
    using _cleanup = { [Symbol.dispose]: () => dom.window.close() };
    const host = dom.window.document.querySelector('main');
    assert.ok(host);
    const command = '  echo "確認"\n# <script>未知の原文</script>  \n';
    let calls = 0;
    using view = {
        ...mountExecutionPreview(
            host,
            {
                command,
                requestLabel: '旧版1',
                workingDirectory: '/検証',
                documents: [{ label: '資料版1', body: '資料の全文\n改行' }],
            },
            () => {
                calls++;
            },
            () => {},
        ),
        [Symbol.dispose]() {
            this.dispose();
        },
    };
    const pres = host.querySelectorAll('pre');
    assert.equal(pres[0].textContent, command);
    assert.equal(pres[1].textContent, '資料の全文\n改行');
    assert.equal(host.querySelectorAll('script').length, 0);
    const send = host.querySelector('button'),
        check = host.querySelector('input');
    assert.ok(send && check);
    assert.equal(send.disabled, true);
    send.click();
    assert.equal(calls, 0);
    view.availability({ allowed: true, reason: '正式な受付のfixture' });
    assert.equal(send.disabled, true);
    check.checked = true;
    check.dispatchEvent(new dom.window.Event('change'));
    send.click();
    send.click();
    assert.equal(calls, 1);
});
test('結果閲覧の未設定と本人表示・DB保存・needsOkを混同せず、ack後readまで保存済み表示しない', async () => {
    const dom = new JSDOM('<main></main>');
    using _cleanup = { [Symbol.dispose]: () => dom.window.close() };
    const host = dom.window.document.querySelector('main');
    assert.ok(host);
    let state: ResultAccessView<string> = {
        context: '確認版1',
        canChangeDisclosure: true,
        userDisplay: '本人のみ可',
        databaseStorage: '保存可',
        aiDisclosure: 'unknown',
        resultConfirmation: '未確認',
    };
    const applied: [string, boolean][] = [];
    let resolveAck: () => void = () => {
        throw Error('未開始');
    };
    using view = {
        ...mountResultAccess(host, {
            read: async () => ({ ...state }),
            changeDisclosure: async (context, allowed) => {
                applied.push([context, allowed]);
                await new Promise<void>((resolve) => {
                    resolveAck = resolve;
                });
                state = {
                    ...state,
                    context: '確認版2',
                    aiDisclosure: 'allowed',
                };
            },
        }),
        [Symbol.dispose]() {
            this.dispose();
        },
    };
    await view.load();
    const change = host.querySelector('button');
    assert.ok(change);
    assert.equal(change.disabled, true);
    assert.match(host.textContent ?? '', /担当AIへの開示: 未設定/);
    state = { ...state, aiDisclosure: 'denied' };
    await view.load();
    change.click();
    await tick();
    assert.deepEqual(applied, [['確認版1', true]]);
    assert.equal(change.disabled, true);
    assert.match(host.textContent ?? '', /非許可/);
    resolveAck();
    await tick();
    await tick();
    assert.match(host.textContent ?? '', /保存と読戻し/);
    assert.match(host.textContent ?? '', /担当AIへの開示: 許可/);
    assert.match(host.textContent ?? '', /needsOk）: 未確認/);
});
test('閲覧設定の保存結果不明では自動再送せず、再取得まで変更を止める', async () => {
    const dom = new JSDOM('<main></main>');
    using _cleanup = { [Symbol.dispose]: () => dom.window.close() };
    const host = dom.window.document.querySelector('main');
    assert.ok(host);
    let sends = 0;
    using view = {
        ...mountResultAccess(host, {
            read: async () => ({
                context: 1,
                canChangeDisclosure: true,
                userDisplay: '可',
                databaseStorage: '保存可',
                aiDisclosure: 'denied',
                resultConfirmation: '確認済み',
            }),
            changeDisclosure: async () => {
                sends++;
                throw Error('応答不明');
            },
        }),
        [Symbol.dispose]() {
            this.dispose();
        },
    };
    await view.load();
    const change = host.querySelector('button');
    assert.ok(change);
    change.click();
    await tick();
    change.click();
    await tick();
    assert.equal(sends, 1);
    assert.equal(change.disabled, true);
    assert.match(host.textContent ?? '', /保存結果が不明/);
});
