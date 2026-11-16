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
            createElement: () => ({ addEventListener() {}, style: {} }),
            body: { appendChild() {} },
        },
        window: { addEventListener() {} },
        Element: class {},
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

test('copy button posts copyText for the hovered code and shows the host result', () => {
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
    const docHandlers = new Map<string, (event: any) => void>();
    const winHandlers = new Map<string, (event: any) => void>();
    const btnHandlers = new Map<string, (event: any) => void>();
    const messages: unknown[] = [];
    const btn: any = {
        hidden: true,
        textContent: '',
        style: {},
        offsetWidth: 60,
        offsetHeight: 20,
        addEventListener: (n: string, h: (e: any) => void) =>
            btnHandlers.set(n, h),
    };
    class El {
        constructor(
            public textContent: string,
            public inPre: boolean
        ) {}
        closest(sel: string) {
            if (sel === 'pre') return this.inPre ? this : null;
            if (sel === 'code') return this;
            return null;
        }
        querySelector() {
            return null;
        }
        getBoundingClientRect() {
            return { top: 100, right: 300 };
        }
    }
    const container = {
        addEventListener() {},
        querySelectorAll: () => [],
        contains: () => true,
    };
    runInNewContext(script, {
        acquireVsCodeApi: () => ({
            postMessage: (m: unknown) => messages.push(m),
        }),
        document: {
            querySelector: (s: string) =>
                s === '.mdd-single' ? container : null,
            createElement: () => btn,
            body: { appendChild() {} },
            addEventListener: (n: string, h: (e: any) => void) =>
                docHandlers.set(n, h),
        },
        window: {
            innerWidth: 800,
            addEventListener: (n: string, h: (e: any) => void) =>
                winHandlers.set(n, h),
        },
        Element: El,
        HTMLInputElement: class {},
        requestAnimationFrame: (cb: () => void) => cb(),
        setTimeout: () => 0,
        clearTimeout() {},
    });
    const inline = new El('echo hi', false);
    docHandlers.get('mouseover')!({ target: inline });
    assert.equal(btn.hidden, false);
    btnHandlers.get('click')!({ stopPropagation() {} });
    const block = new El('line1\nline2\n', true);
    docHandlers.get('mouseover')!({ target: block });
    btnHandlers.get('click')!({ stopPropagation() {} });
    assert.equal(
        JSON.stringify(messages),
        JSON.stringify([
            { type: 'copyText', text: 'echo hi' },
            { type: 'copyText', text: 'line1\nline2' },
        ])
    );
    winHandlers.get('message')!({ data: { type: 'copied', ok: true } });
    assert.equal(btn.textContent, 'コピーしました');
});
