import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import type * as vscode from 'vscode';
import { buildSinglePaneHtml } from '../src/webview.js';

test('generated webview sends a checkbox change once and disables controls while saving', () => {
    const html = buildSinglePaneHtml({
        title: 'test',
        subtitle: 'test',
        bodyHtml: '',
        styleUri: 'style.css' as unknown as vscode.Uri,
        webviewScriptUri: 'webview.js' as unknown as vscode.Uri,
        cspSource: "'self'",
        nonce: 'testnonce',
    });
    const script = html.match(
        /<script nonce="testnonce">([\s\S]*?)<\/script>/
    )![1];
    const handlers = new Map<string, (event: { target: unknown }) => void>();
    const messages: unknown[] = [];
    class Input {
        disabled = false;
        checked = true;
        constructor(public dataset: { mddCheckbox?: string }) {}
    }
    const input = new Input({ mddCheckbox: 'fresh-0' });
    const peer = new Input({ mddCheckbox: 'fresh-1' });
    const container = {
        addEventListener: (
            event: string,
            handler: (event: { target: unknown }) => void
        ) => handlers.set(event, handler),
        querySelectorAll: () => [input, peer],
    };
    runInNewContext(script, {
        acquireVsCodeApi: () => ({
            postMessage: (message: unknown) => messages.push(message),
        }),
        document: {
            querySelector: (selector: string) =>
                selector === '.mdd-single' ? container : null,
            addEventListener() {},
        },
        window: { addEventListener() {} },
        requestAnimationFrame: (callback: () => void) => callback(),
        HTMLInputElement: Input,
    });
    const change = handlers.get('change')!;
    change({ target: new Input({}) });
    assert.equal(messages.length, 0);
    change({ target: input });
    assert.equal(
        JSON.stringify(messages),
        JSON.stringify([
            { type: 'toggleCheckbox', key: 'fresh-0', checked: true },
        ])
    );
    assert.equal(input.disabled, true);
    assert.equal(peer.disabled, true);
    change({ target: peer });
    assert.equal(messages.length, 1);
});
