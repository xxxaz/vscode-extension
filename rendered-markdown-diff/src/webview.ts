import type * as vscode from 'vscode';

/**
 * webview からホスト (extension) へ送るアクション要求。
 *
 *   - openText: file: をテキストエディタで開き直す (編集可能)
 *   - openHeadDiff: file: 単独時に「現行 vs HEAD」の diff editor を開く
 *   - openWorkingTreeDiff: 非 file: 単独時に「現行 ref 内容 vs 作業ツリー」の diff editor を開く
 *   - openWorktree: 非 file: を見ている時に、対応する作業ツリーのファイルを viewer で開く
 *   - openSourceText: 非 file: の ref 内容を read-only テキストで開く (immutable)
 *   - openSingle: クリックされたパス側の URI を単独 viewer で開く (diff モードの subtitle click)
 *   - scroll: peer pane との scroll 同期
 */
export type WebviewAction =
    | { type: 'openText' }
    | { type: 'openHeadDiff' }
    | { type: 'openWorkingTreeDiff' }
    | { type: 'openWorktree'; newTab?: boolean }
    | { type: 'openSourceText'; newTab?: boolean }
    | { type: 'openSingle'; newTab?: boolean }
    | { type: 'openLink'; href: string; newTab?: boolean }
    | { type: 'openExternal'; href: string }
    /** 本文中のコミット参照 (検証済み SHA / GitHub・GitLab URL) → git-commit-browser */
    | {
          type: 'openCommitRef';
          kind: 'commit' | 'blob';
          ref: string;
          file?: string;
          href?: string;
          newTab?: boolean;
      }
    /** ヘッダーの「⎇ Commit」: 表示中ファイルの commit を Git Commit Browser で開く */
    | { type: 'openCommitBrowser' }
    /** ヘッダーの「⎇ Compare」(比較の右 pane のみ): 2 ref を ref 間比較で開く */
    | { type: 'openCompareBrowser' }
    | { type: 'historyBack' }
    | { type: 'historyForward' }
    | { type: 'scroll'; ratio: number };

type ActionConfig = {
    /** "Edit" ボタン: file: をテキストエディタで開く (file: scheme 時のみ) */
    openText?: boolean;
    /** "↔ HEAD" ボタン: file: vs HEAD diff (file: scheme + git 管理下のみ) */
    openHeadDiff?: boolean;
    /** "↔ Worktree" ボタン: 非 file: vs 作業ツリー diff */
    openWorkingTreeDiff?: boolean;
    /** "→ Worktree" ボタン: 対応する作業ツリーのファイルを viewer で開く */
    openWorktree?: boolean;
    /** openWorktree を出すが、対応ファイルが無いので無効化する */
    openWorktreeDisabled?: boolean;
    /** "Source" ボタン: ref 内容を read-only テキストで開く */
    openSourceText?: boolean;
    /** "⎇ Commit" ボタン: 表示中ファイルの commit を Git Commit Browser で開く */
    openCommitBrowser?: boolean;
    /** "⎇ Compare" ボタン: 比較の **右(modified) pane のみ**。2 ref を ref 間比較 */
    openCompareBrowser?: boolean;
    /** subtitle 自体を click で「単独 viewer」起動 trigger にする (diff pane 時のみ) */
    subtitleAsOpenSingle?: boolean;
};

type SinglePaneOptions = {
    title: string;
    subtitle: string;
    bodyHtml: string;
    styleUri: vscode.Uri;
    /** browser 側 bundle (`media/webview.js`) の webview URI。mermaid 等を初期化する */
    webviewScriptUri: vscode.Uri;
    cspSource: string;
    nonce: string;
    actions?: ActionConfig;
    /** body 直下に追加する CSS class (e.g. "mdd-single-gutter") */
    bodyClass?: string;
};

/**
 * smart viewer 用の単一ペイン HTML を構築する。
 *
 * 同梱する script:
 *   - スクロール位置を `{ type: 'scroll', ratio }` で extension に通知
 *   - 逆方向に `{ type: 'scroll', ratio }` を受けたら自分のスクロールに反映 (sister 連動)
 *   - `.mdd-ins` / `.mdd-del` / `.mdd-ins-gutter` / `.mdd-del-marker` の位置から右側 rail に変更マーカーを描画
 *   - アクションボタンや subtitle クリックを `WebviewAction` として host に通知
 */
export function buildSinglePaneHtml(opts: SinglePaneOptions): string {
    const {
        title,
        subtitle,
        bodyHtml,
        styleUri,
        webviewScriptUri,
        cspSource,
        nonce,
        actions,
        bodyClass,
    } = opts;
    // mermaid のレンダラーは内部で `Function()` 構文を使う箇所があるため `'unsafe-eval'` が必要
    const csp = [
        `default-src 'none'`,
        `style-src ${cspSource} 'unsafe-inline'`,
        `script-src ${cspSource} 'nonce-${nonce}' 'unsafe-eval'`,
        `img-src ${cspSource} https: data:`,
        `font-src ${cspSource} data:`,
    ].join('; ');

    const subtitleAttrs = actions?.subtitleAsOpenSingle
        ? ' class="mdd-subtitle mdd-subtitle-link" data-action="openSingle" role="button" tabindex="0" title="この内容を新しいタブで単独表示"'
        : ' class="mdd-subtitle"';

    const actionsHtml = renderActions(actions);

    return `<!DOCTYPE html>
<html lang="ja">
<head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="${csp}" />
    <link rel="stylesheet" href="${styleUri}" />
    <title>${escapeAttr(title)}</title>
</head>
<body${bodyClass ? ` class="${escapeAttr(bodyClass)}"` : ''}>
    <header class="mdd-header">
        <p${subtitleAttrs}>${escapeText(subtitle)}</p>
        ${actionsHtml}
    </header>
    <main class="mdd-single">
        <div class="mdd-content">${bodyHtml}</div>
    </main>
    <div class="mdd-rail" aria-hidden="true"></div>
    <script nonce="${nonce}" src="${webviewScriptUri}"></script>
    <script nonce="${nonce}">
        (function () {
            const vscode = acquireVsCodeApi();
            const container = document.querySelector('.mdd-single');
            const rail = document.querySelector('.mdd-rail');
            if (!container) return;

            let suppressEmit = false;

            // (1) スクロール同期 (sister webview と双方向に同期)
            container.addEventListener('scroll', () => {
                if (suppressEmit) return;
                const max = Math.max(1, container.scrollHeight - container.clientHeight);
                vscode.postMessage({ type: 'scroll', ratio: container.scrollTop / max });
            }, { passive: true });

            window.addEventListener('message', (e) => {
                const msg = e.data;
                if (!msg || msg.type !== 'scroll') return;
                const max = Math.max(1, container.scrollHeight - container.clientHeight);
                suppressEmit = true;
                container.scrollTop = msg.ratio * max;
                requestAnimationFrame(() => { suppressEmit = false; });
            });

            // (2) スクロールバー横の変更マーカー rail
            function updateRail() {
                if (!rail) return;
                rail.innerHTML = '';
                const marks = container.querySelectorAll('.mdd-ins, .mdd-del, .mdd-ins-gutter, .mdd-mod-gutter, .mdd-del-marker');
                if (marks.length === 0) return;
                const total = Math.max(1, container.scrollHeight);
                const railH = rail.clientHeight;
                for (const el of marks) {
                    const top = (el.offsetTop / total) * railH;
                    const height = Math.max(2, (el.offsetHeight / total) * railH);
                    const m = document.createElement('div');
                    if (el.classList.contains('mdd-del') || el.classList.contains('mdd-del-marker')) {
                        m.className = 'mdd-rail-del';
                    } else if (el.classList.contains('mdd-mod-gutter')) {
                        m.className = 'mdd-rail-mod';
                    } else {
                        m.className = 'mdd-rail-add';
                    }
                    m.style.top = top + 'px';
                    m.style.height = height + 'px';
                    rail.appendChild(m);
                }
            }
            requestAnimationFrame(updateRail);
            window.addEventListener('resize', updateRail);
            // webviewMermaid.ts が mermaid SVG レンダリング完了後に発火する
            // (SVG 挿入で offsetTop / scrollHeight が変わるので rail を打ち直す)
            window.addEventListener('mdd-rail-update', updateRail);

            // 通常クリック → タブ内切替 (host 側で preview タブ再利用)
            // Ctrl/⌘ or 中クリック → 新しいタブ
            function wantsNewTab(ev) {
                return !!ev && (ev.ctrlKey || ev.metaKey || ev.button === 1);
            }

            // (3) アクションボタン / subtitle click を host に通知
            function postAction(action, ev) {
                if (!action) return;
                vscode.postMessage({ type: action, newTab: wantsNewTab(ev) });
            }
            function actionTarget(e) {
                return e.target instanceof Element
                    ? e.target.closest('[data-action]')
                    : null;
            }
            document.addEventListener('click', (e) => {
                const target = actionTarget(e);
                if (!target) return;
                postAction(target.getAttribute('data-action'), e);
            });
            document.addEventListener('auxclick', (e) => {
                if (e.button !== 1) return;
                const target = actionTarget(e);
                if (!target) return;
                postAction(target.getAttribute('data-action'), e);
            });
            document.addEventListener('keydown', (e) => {
                if (e.key !== 'Enter' && e.key !== ' ') return;
                const target = actionTarget(e);
                if (!target) return;
                e.preventDefault();
                postAction(target.getAttribute('data-action'), e);
            });

            // (4) markdown 内の <a href="..."> リンク
            //     - 同一ページ内 anchor (#xxx) はブラウザに任せる
            //     - http / https / mailto / vscode 等は openExternal で外部に出す
            //     - それ以外 (相対 / 絶対 path) は openLink で host に投げて
            //       現行 URI 基準で「同じ commit / 作業ツリー」のファイルを開かせる
            //       (通常クリック=タブ内 / Ctrl・中クリック=新タブ)
            function handleAnchor(e, a) {
                // 検証済み bare SHA の autolink (diff.ts が data-commit-ref を付与)
                const commitRef = a.getAttribute('data-commit-ref');
                if (commitRef) {
                    e.preventDefault();
                    vscode.postMessage({ type: 'openCommitRef', kind: 'commit', ref: commitRef, newTab: wantsNewTab(e) });
                    return;
                }
                const href = a.getAttribute('href');
                if (!href) return;
                if (href.startsWith('#')) return;
                // GitHub/GitLab の commit/blob URL かどうかの判定は host 側で行う
                // (webview の埋め込みスクリプトは template literal 内なので
                //  バックスラッシュを含む正規表現リテラルを置けない)。
                if (/^(https?:|mailto:|vscode:|vscode-insiders:|ftp:)/i.test(href)) {
                    e.preventDefault();
                    vscode.postMessage({ type: 'openExternal', href });
                    return;
                }
                e.preventDefault();
                vscode.postMessage({ type: 'openLink', href, newTab: wantsNewTab(e) });
            }
            document.addEventListener('click', (e) => {
                if (!(e.target instanceof Element)) return;
                const a = e.target.closest('a');
                if (a) handleAnchor(e, a);
            });
            document.addEventListener('auxclick', (e) => {
                if (e.button !== 1 || !(e.target instanceof Element)) return;
                const a = e.target.closest('a');
                if (a) handleAnchor(e, a);
            });

            // (5) ヒストリ操作: マウスの戻る/進む (button 3/4) と Alt+←/→
            //     mermaid 拡大 overlay 表示中は誤爆を避けて無視
            function historyNav(dir) {
                if (document.querySelector('.mdd-mermaid-overlay')) return;
                vscode.postMessage({ type: dir === 'back' ? 'historyBack' : 'historyForward' });
            }
            window.addEventListener('mouseup', (e) => {
                if (e.button === 3) { e.preventDefault(); historyNav('back'); }
                else if (e.button === 4) { e.preventDefault(); historyNav('forward'); }
            });
            window.addEventListener('keydown', (e) => {
                if (!e.altKey) return;
                if (e.key === 'ArrowLeft') { e.preventDefault(); historyNav('back'); }
                else if (e.key === 'ArrowRight') { e.preventDefault(); historyNav('forward'); }
            });
        })();
    </script>
</body>
</html>`;
}

function renderActions(actions: ActionConfig | undefined): string {
    if (!actions) return '';
    const buttons: string[] = [];
    if (actions.openHeadDiff) {
        buttons.push(
            `<button type="button" class="mdd-action-btn" data-action="openHeadDiff" title="現行ファイルと HEAD の diff を開く">↔ HEAD</button>`,
        );
    }
    if (actions.openWorkingTreeDiff) {
        buttons.push(
            `<button type="button" class="mdd-action-btn" data-action="openWorkingTreeDiff" title="この ref 内容と作業ツリーの diff を開く">↔ Worktree</button>`,
        );
    }
    if (actions.openWorktree || actions.openWorktreeDisabled) {
        const disabled = actions.openWorktreeDisabled;
        buttons.push(
            `<button type="button" class="mdd-action-btn" data-action="openWorktree"${
                disabled
                    ? ' disabled aria-disabled="true" title="対応する作業ツリーのファイルがありません"'
                    : ' title="対応する作業ツリーのファイルを viewer で開く"'
            }>→ Worktree</button>`,
        );
    }
    if (actions.openSourceText) {
        buttons.push(
            `<button type="button" class="mdd-action-btn" data-action="openSourceText" title="この ref の内容を read-only テキストで開く">&lt;/&gt; Source</button>`,
        );
    }
    if (actions.openText) {
        buttons.push(
            `<button type="button" class="mdd-action-btn" data-action="openText" title="テキストエディタで開く (編集可能)">✎ Edit</button>`,
        );
    }
    if (actions.openCommitBrowser) {
        buttons.push(
            `<button type="button" class="mdd-action-btn" data-action="openCommitBrowser" title="表示中ファイルの commit を Git Commit Browser で開く">⎇ Commit</button>`,
        );
    }
    if (actions.openCompareBrowser) {
        buttons.push(
            `<button type="button" class="mdd-action-btn" data-action="openCompareBrowser" title="この比較の 2 ref を Git Commit Browser (ref 間比較) で開く">⎇ Compare</button>`,
        );
    }
    if (buttons.length === 0) return '';
    return `<div class="mdd-actions">${buttons.join('')}</div>`;
}

export function generateNonce(): string {
    const bytes = new Uint8Array(16);
    for (let i = 0; i < bytes.length; i++)
        bytes[i] = Math.floor(Math.random() * 256);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function escapeText(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttr(s: string): string {
    return escapeText(s).replace(/"/g, '&quot;');
}
