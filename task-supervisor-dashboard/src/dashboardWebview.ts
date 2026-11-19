const escapeAttribute = (value: string): string =>
    value.replace(
        /[&<>"']/g,
        (char) =>
            ({
                '&': '&amp;',
                '<': '&lt;',
                '>': '&gt;',
                '"': '&quot;',
                "'": '&#39;',
            })[char] ?? char,
    );

export function boardHtml(
    cspSource: string,
    nonce: string,
    scriptUri: string,
    workspaceUri = '',
): string {
    const safeNonce = escapeAttribute(nonce);
    const source = escapeAttribute(cspSource);
    return `<!DOCTYPE html>
<html lang="ja"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${safeNonce}'; style-src 'nonce-${safeNonce}'; font-src ${source}; connect-src 'none';">
<title>進行中タスク</title>
<style nonce="${safeNonce}">
:root { color-scheme: light dark; --fallback-bg: #ffffff; --fallback-fg: #25262a; --fallback-muted: #60646c; --fallback-border: #d9dce1; --fallback-surface: #f6f7f9; --fallback-link: #1859ad; --fallback-warning: #8b5900; --fallback-error: #b12525; --fallback-success: #257044; --bg: var(--vscode-editor-background, var(--fallback-bg)); --fg: var(--vscode-editor-foreground, var(--fallback-fg)); --muted: var(--vscode-descriptionForeground, var(--fallback-muted)); --border: var(--vscode-panel-border, var(--fallback-border)); --surface: var(--vscode-sideBar-background, var(--fallback-surface)); --link: var(--vscode-textLink-foreground, var(--fallback-link)); --focus: var(--vscode-focusBorder, #4285ef); --warning: var(--vscode-editorWarning-foreground, var(--fallback-warning)); --error: var(--vscode-errorForeground, var(--fallback-error)); --success: var(--vscode-testing-iconPassed, var(--fallback-success)); }
@media (prefers-color-scheme: dark) { :root { --fallback-bg: #202124; --fallback-fg: #e3e3e5; --fallback-muted: #b5b7bd; --fallback-border: #464950; --fallback-surface: #27292d; --fallback-link: #8ab4f8; --fallback-warning: #e5ba6b; --fallback-error: #f48787; --fallback-success: #89c69c; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font-family: var(--vscode-font-family, system-ui, sans-serif); font-size: var(--vscode-font-size, 13px); line-height: 1.65; }
button, input { font: inherit; }
button { cursor: pointer; }
button:disabled { opacity: .55; cursor: wait; }
button:focus-visible, input:focus-visible, summary:focus-visible { outline: 2px solid var(--focus); outline-offset: 3px; }
[hidden] { display: none !important; }
.board { max-width: 1120px; margin: 0 auto; padding: 20px 24px 48px; }
.heading-row { display: flex; gap: 16px; align-items: center; justify-content: space-between; }
h1 { font-size: 1.6rem; line-height: 1.4; margin: 0; letter-spacing: .01em; }
h2 { display: inline; font-size: 1.14rem; line-height: 1.5; font-weight: 650; margin: 0; }
p { margin: 0; }
.metadata { color: var(--muted); margin: 8px 0; font-size: .92em; overflow-wrap: anywhere; }
.supervisor { margin: 4px 0 8px; }
.counts { display: flex; flex-wrap: wrap; gap: 6px 12px; padding: 10px 0 16px; }
.text-link, .count-link { border: 0; border-radius: 2px; padding: 0; color: var(--link); background: transparent; text-align: left; overflow-wrap: anywhere; white-space: inherit; text-decoration: underline; text-underline-offset: 3px; }
.count-link { text-decoration: none; border-bottom: 1px solid var(--border); }
.count-link:hover, .text-link:hover { text-decoration: underline; }
.refresh, .operation { border: 1px solid var(--vscode-button-border, var(--border)); border-radius: 3px; padding: 5px 12px; background: var(--vscode-button-secondaryBackground, var(--surface)); color: var(--vscode-button-secondaryForeground, var(--fg)); line-height: 1.5; }
.refresh:hover, .operation:hover { background: var(--vscode-button-secondaryHoverBackground, var(--surface)); }
.filter-label { display: flex; flex-direction: column; gap: 5px; color: var(--muted); font-size: .92em; }
.filter { width: 100%; border: 1px solid var(--vscode-input-border, var(--border)); border-radius: 3px; background: var(--vscode-input-background, var(--bg)); color: var(--vscode-input-foreground, var(--fg)); padding: 7px 9px; line-height: 1.5; }
.filter::placeholder { color: var(--vscode-input-placeholderForeground, var(--muted)); }
.status, .warnings { margin: 16px 0; padding: 10px 12px; background: var(--surface); border-left: 3px solid var(--muted); overflow-wrap: anywhere; white-space: pre-wrap; }
.status[data-state=success] { border-color: var(--success); }
.status[data-state=failed], .status[data-state=error] { border-color: var(--error); }
.status[data-state=queued], .status[data-state=pending], .status[data-state=busy], .status[data-state=warning], .warnings { border-color: var(--warning); }
.warnings p + p { margin-top: 8px; }
.sections { margin-top: 24px; }
.board-section { margin-bottom: 26px; scroll-margin-top: 16px; }
.section-summary { border-bottom: 1px solid var(--border); padding: 8px 0; cursor: pointer; }
.section-summary::marker, .card-summary::marker { color: var(--muted); }
.section-count { margin-left: 10px; color: var(--muted); font-size: .92em; white-space: nowrap; }
.section-description { color: var(--muted); margin: 10px 0 12px; white-space: pre-wrap; overflow-wrap: anywhere; }
.card-list { display: flex; flex-direction: column; gap: 10px; margin-top: 12px; }
.card { border: 1px solid var(--border); border-radius: 4px; scroll-margin-top: 16px; min-width: 0; }
.card-summary { position: relative; padding: 12px 14px; cursor: pointer; overflow-wrap: anywhere; }
.card-id { font-family: var(--vscode-editor-font-family, ui-monospace, monospace); font-weight: 650; margin-right: 9px; }
.badge { display: inline-block; margin: 0 9px 3px 0; padding: 0 6px; background: var(--surface); border: 1px solid var(--border); border-radius: 3px; font-size: .87em; }
.card[data-tone=warning] .badge { color: var(--warning); }
.card[data-tone=success] .badge { color: var(--success); }
.card-title { font-weight: 650; }
.card-excerpt { display: block; color: var(--muted); margin-top: 5px; white-space: pre-wrap; font-size: .96em; }
.card[open] > .card-summary { border-bottom: 1px solid var(--border); }
.card-body { padding: 4px 14px 14px; }
.fields { margin: 0; }
.field { display: grid; grid-template-columns: minmax(105px, 145px) minmax(0, 1fr); gap: 8px 16px; padding: 10px 0; border-bottom: 1px solid var(--border); }
dt { color: var(--muted); font-size: .92em; }
dd { margin: 0; min-width: 0; }
.field-value { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; word-break: normal; }
.field-value > * { display: block; }
.field-value > * + * { margin-top: 4px; }
pre.field-value { font-family: var(--vscode-editor-font-family, ui-monospace, monospace); font-size: .92em; line-height: 1.7; padding: 9px 10px; background: var(--vscode-textCodeBlock-background, var(--surface)); border-radius: 3px; }
code { font-family: var(--vscode-editor-font-family, ui-monospace, monospace); font-size: .95em; }
.card-links { display: flex; flex-wrap: wrap; gap: 7px 16px; margin-top: 12px; }
.operations { display: flex; flex-wrap: wrap; gap: 8px; padding-top: 14px; }
.section-empty, .board-empty { color: var(--muted); padding: 18px 0; }
@media (max-width: 520px) { .board { padding: 14px 12px 32px; } h1 { font-size: 1.3rem; } .heading-row { gap: 8px; } .field { display: block; } dt { margin-bottom: 5px; } .card-summary { padding: 10px; } .card-body { padding: 2px 10px 12px; } .counts { gap: 6px 10px; } .refresh, .operation { padding: 5px 9px; } }
@media (prefers-reduced-motion: reduce) { * { scroll-behavior: auto !important; } }
</style></head><body><div id="board" data-workspace-uri="${escapeAttribute(workspaceUri)}"></div><script nonce="${safeNonce}" src="${escapeAttribute(scriptUri)}"></script></body></html>`;
}
