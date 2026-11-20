import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import {
    mountExecutionPreview,
    mountResultAccess,
    type ResultAccessView,
} from '../src/executionView.ts';

const tick = async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
};
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
