/**
 * webview 側 (browser) で動く mermaid 初期化 + 拡大表示スクリプト。
 *
 * esbuild が `media/webview.js` に IIFE bundle として吐き出し、
 * `webview.ts` で `<script src="${webviewJsUri}" nonce="...">` から読み込まれる。
 *
 * 動作:
 *   - VSCode の body class (`vscode-dark` / `vscode-light` / `vscode-high-contrast`) から theme を選択
 *   - `mermaid.initialize({startOnLoad: false, ...})` で初期化
 *   - `.mermaid` 要素を走査して `mermaid.run()` で SVG レンダリング
 *   - レンダリング完了後に `mdd-rail-update` イベントを発火し、ホスト側の rail 再描画を促す
 *   - 各 `.mermaid` に click 連打可能な拡大表示 overlay を仕掛ける。
 *     overlay 内で SVG の text 要素を実測し、最小文字高が `TARGET_TEXT_PX` を下回って
 *     いれば自動で SVG 幅を拡大してから表示する (テキスト基準のリーダブルスケール)。
 *     ヘッダーの + / − / リセットボタンと wheel 操作で任意倍率に微調整可能。
 */
import mermaid from 'mermaid';

/** auto-scale の目標: 最小文字が最低でもこの高さ (px) を持つようにする */
const TARGET_TEXT_PX = 16;
const ZOOM_STEP = 1.25;
const ZOOM_MIN = 0.25;
const ZOOM_MAX = 8;

function pickTheme(): 'dark' | 'default' {
    const cls = document.body.classList;
    if (cls.contains('vscode-dark') || cls.contains('vscode-high-contrast'))
        return 'dark';
    return 'default';
}

mermaid.initialize({
    startOnLoad: false,
    theme: pickTheme(),
    securityLevel: 'strict',
});

async function renderAll(): Promise<void> {
    const nodes = document.querySelectorAll<HTMLElement>(
        '.mermaid:not([data-mdd-rendered])',
    );
    if (nodes.length === 0) return;
    try {
        await mermaid.run({ nodes: Array.from(nodes) });
    } catch (err) {
        console.error('[rendered-markdown-diff] mermaid render failed', err);
    }
    nodes.forEach((n) => {
        n.setAttribute('data-mdd-rendered', 'true');
        attachZoomHandler(n);
    });
    window.dispatchEvent(new Event('mdd-rail-update'));
}

function attachZoomHandler(node: HTMLElement): void {
    if (node.dataset.mddZoomBound === 'true') return;
    node.dataset.mddZoomBound = 'true';
    node.style.cursor = 'zoom-in';
    node.addEventListener('click', (e) => {
        const t = e.target as HTMLElement | null;
        if (!t) return;
        if (t.closest('a, button')) return;
        openZoom(node);
    });
}

let lastEscHandler: ((e: KeyboardEvent) => void) | undefined;

function openZoom(sourceNode: HTMLElement): void {
    // 既存 overlay があれば閉じる (連続 click 対策)
    document.querySelectorAll('.mdd-mermaid-overlay').forEach((el) => {
        el.remove();
    });
    if (lastEscHandler) {
        document.removeEventListener('keydown', lastEscHandler);
        lastEscHandler = undefined;
    }

    const svg = sourceNode.querySelector('svg');
    if (!svg) return;

    const overlay = document.createElement('div');
    overlay.className = 'mdd-mermaid-overlay';

    // ヘッダー (右上): ズーム操作と閉じる
    const header = document.createElement('div');
    header.className = 'mdd-mermaid-overlay-header';
    const zoomOut = makeBtn('−', 'ズームアウト');
    const zoomLabel = document.createElement('span');
    zoomLabel.className = 'mdd-mermaid-overlay-zoom-label';
    const zoomIn = makeBtn('+', 'ズームイン');
    const zoomReset = makeBtn('Fit', '自動倍率に戻す');
    const closeBtn = makeBtn('×', '閉じる');
    closeBtn.classList.add('mdd-mermaid-overlay-close-btn');
    header.append(zoomOut, zoomLabel, zoomIn, zoomReset, closeBtn);

    const content = document.createElement('div');
    content.className = 'mdd-mermaid-overlay-content';

    // SVG を outerHTML → innerHTML で reparse して埋め込む (cloneNode より SVG 復元が確実)
    const wrapper = document.createElement('div');
    wrapper.className = 'mermaid mdd-mermaid-zoomed';
    wrapper.innerHTML = svg.outerHTML;
    const parsedSvg = wrapper.querySelector('svg') as SVGSVGElement | null;
    if (parsedSvg) {
        // 元 SVG の width / height / style を剥がして、wrapper の inline width で
        // 一律スケールを駆動する
        parsedSvg.removeAttribute('style');
        parsedSvg.removeAttribute('width');
        parsedSvg.removeAttribute('height');
    }
    content.appendChild(wrapper);

    overlay.appendChild(header);
    overlay.appendChild(content);
    document.body.appendChild(overlay);

    // viewBox の自然幅を起点にスケールを管理する
    const naturalWidth = readViewBoxWidth(parsedSvg) ?? 800;
    let autoScale = 1; // 後で text 実測で更新
    let scale = 1;

    const applyScale = (s: number): void => {
        scale = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, s));
        wrapper.style.width = `${Math.round(naturalWidth * scale)}px`;
        zoomLabel.textContent = `${Math.round(scale * 100)}%`;
    };

    // 初回描画後、text 要素の screen 高さを実測し、TARGET_TEXT_PX に届くよう auto-scale
    requestAnimationFrame(() => {
        applyScale(1);
        requestAnimationFrame(() => {
            const desired = computeReadableScale(wrapper, 1);
            autoScale = desired;
            applyScale(autoScale);
        });
    });

    // ズームボタン
    zoomIn.addEventListener('click', (e) => {
        e.stopPropagation();
        applyScale(scale * ZOOM_STEP);
    });
    zoomOut.addEventListener('click', (e) => {
        e.stopPropagation();
        applyScale(scale / ZOOM_STEP);
    });
    zoomReset.addEventListener('click', (e) => {
        e.stopPropagation();
        applyScale(autoScale);
    });

    // wheel + Ctrl で連続ズーム
    overlay.addEventListener(
        'wheel',
        (e) => {
            if (!e.ctrlKey && !e.metaKey) return;
            e.preventDefault();
            const factor = e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP;
            applyScale(scale * factor);
        },
        { passive: false },
    );

    // 左ボタン (mouse button 0) のドラッグで content を pan できるようにする。
    //   - mousedown 時に preventDefault: ブラウザの text 選択や drag 開始を抑止
    //   - mousemove で scrollLeft / scrollTop を delta 分反転加算
    //   - 移動量が閾値 4px を超えたら dragMoved を立て、直後の overlay click による
    //     close を 1 回だけ抑止する (drag end が overlay 外に来るケース対策)
    //   - Ctrl / Cmd 押下中は drag pan を抑止して、native text 選択モードに倒す
    //     (`.mdd-mermaid-select-mode` クラスで user-select / cursor を上書き)
    let isDragging = false;
    let dragStartX = 0;
    let dragStartY = 0;
    let dragStartScrollLeft = 0;
    let dragStartScrollTop = 0;
    let dragMoved = false;

    const onMouseMove = (e: MouseEvent): void => {
        if (!isDragging) return;
        const dx = e.clientX - dragStartX;
        const dy = e.clientY - dragStartY;
        if (!dragMoved && Math.abs(dx) + Math.abs(dy) > 4) dragMoved = true;
        content.scrollLeft = dragStartScrollLeft - dx;
        content.scrollTop = dragStartScrollTop - dy;
    };
    const onMouseUp = (e: MouseEvent): void => {
        if (e.button !== 0) return;
        if (!isDragging) return;
        isDragging = false;
        content.classList.remove('mdd-mermaid-panning');
    };
    content.addEventListener('mousedown', (e) => {
        // 中 / 右 / その他のボタンは触らない (ブラウザ標準動作に任せる)
        if (e.button !== 0) return;
        if (
            (e.target as Element | null)?.closest(
                '.mdd-mermaid-overlay-header, button, a',
            )
        )
            return;
        // Ctrl / Cmd 押下中は drag pan を抑止して native text 選択に倒す
        if (e.ctrlKey || e.metaKey) return;
        isDragging = true;
        dragMoved = false;
        dragStartX = e.clientX;
        dragStartY = e.clientY;
        dragStartScrollLeft = content.scrollLeft;
        dragStartScrollTop = content.scrollTop;
        content.classList.add('mdd-mermaid-panning');
        e.preventDefault();
    });
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);

    // Ctrl / Cmd 押下中は selection モードに切替える
    // (`.mdd-mermaid-select-mode` クラスで cursor: text / user-select: text に上書き)
    const onKeyDown = (e: KeyboardEvent): void => {
        if (e.key === 'Control' || e.key === 'Meta') {
            content.classList.add('mdd-mermaid-select-mode');
        }
    };
    const onKeyUp = (e: KeyboardEvent): void => {
        if (e.key === 'Control' || e.key === 'Meta') {
            content.classList.remove('mdd-mermaid-select-mode');
        }
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);

    // 閉じる動線
    const close = (): void => {
        overlay.remove();
        window.removeEventListener('mousemove', onMouseMove);
        window.removeEventListener('mouseup', onMouseUp);
        window.removeEventListener('keydown', onKeyDown);
        window.removeEventListener('keyup', onKeyUp);
        if (lastEscHandler) {
            document.removeEventListener('keydown', lastEscHandler);
            lastEscHandler = undefined;
        }
    };
    overlay.addEventListener('click', (e) => {
        // drag pan 直後の click は close を抑止
        if (dragMoved) {
            dragMoved = false;
            return;
        }
        if (e.target === overlay) close();
    });
    closeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        close();
    });
    lastEscHandler = (e) => {
        if (e.key === 'Escape') {
            e.preventDefault();
            close();
        }
    };
    document.addEventListener('keydown', lastEscHandler);
}

function makeBtn(label: string, title: string): HTMLButtonElement {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'mdd-mermaid-overlay-btn';
    b.title = title;
    b.setAttribute('aria-label', title);
    b.textContent = label;
    return b;
}

function readViewBoxWidth(svg: SVGSVGElement | null): number | undefined {
    if (!svg) return undefined;
    const vb = svg.getAttribute('viewBox');
    if (!vb) return undefined;
    const parts = vb.trim().split(/\s+/).map(Number);
    const w = parts[2];
    return Number.isFinite(w) && w > 0 ? w : undefined;
}

/**
 * 現状のスケール `currentScale` での text 要素実測高から、最小文字が
 * `TARGET_TEXT_PX` 以上になるための必要スケールを返す。
 * text が無ければ `currentScale` を維持。
 */
function computeReadableScale(
    wrapper: HTMLElement,
    currentScale: number,
): number {
    const texts = wrapper.querySelectorAll('text, tspan');
    let minH = Number.POSITIVE_INFINITY;
    texts.forEach((t) => {
        const r = (t as Element).getBoundingClientRect();
        if (r.height > 0 && r.height < minH) minH = r.height;
    });
    if (!Number.isFinite(minH)) return currentScale;
    if (minH >= TARGET_TEXT_PX) return currentScale;
    return Math.min(ZOOM_MAX, currentScale * (TARGET_TEXT_PX / minH));
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        void renderAll();
    });
} else {
    void renderAll();
}
