import type {
    BoardCard,
    BoardLink,
    BoardMessage,
    BoardOperation,
    BoardSection,
    BoardSnapshot,
    BoardUpdate,
} from './dashboardTypes.ts';

interface SavedState {
    version: 1;
    query: string;
    sections: Record<string, boolean>;
    cards: Record<string, boolean>;
    scrollTop: number;
}
interface CardView {
    node: HTMLDetailsElement;
    summary: HTMLElement;
    id: HTMLElement;
    badge: HTMLElement;
    title: HTMLElement;
    excerpt: HTMLElement;
    fields: HTMLElement;
    links: HTMLElement;
    operations: HTMLElement;
    signature: string;
}
interface SectionView {
    node: HTMLDetailsElement;
    title: HTMLElement;
    count: HTMLElement;
    description: HTMLElement;
    list: HTMLElement;
    empty: HTMLElement;
    cards: Map<string, CardView>;
}
const operations = new Set(['complete', 'ran', 'answer']);
const sourceLabels = {
    legacy: '監督台帳',
    shadow: '切替前の台帳',
    authoritative: '常駐部の正本',
} satisfies Record<BoardSnapshot['source'], string>;

function displayTime(timestamp: number | null): string {
    if (timestamp === null) return '時刻不明';
    const date = new Date(timestamp);
    return Number.isNaN(date.getTime())
        ? '時刻不明'
        : date.toLocaleString('ja-JP');
}

function describeSnapshot(snapshot: BoardSnapshot): string {
    const details = [
        `更新 ${displayTime(snapshot.updatedAt)}`,
        sourceLabels[snapshot.source],
    ];
    if (snapshot.workspace) details.push(snapshot.workspace);
    const view = snapshot.userActions;
    if (view) {
        if (view.source.mode !== snapshot.source)
            details.push(`依頼の取得元 ${sourceLabels[view.source.mode]}`);
        details.push(
            `依頼一覧の版 ${view.viewVersion ?? '不明'}`,
            `取得時点 ${displayTime(view.source.fetchedAt)}`,
        );
        if (view.status === 'unavailable') {
            const code = view.source.error?.code;
            details.push(code ? `取得失敗（${code}）` : '取得失敗');
            if (view.lastSuccessful) {
                const { viewVersion, fetchedAt } = view.lastSuccessful;
                details.push(
                    `前回正常取得 ${displayTime(fetchedAt)}（版 ${viewVersion}）`,
                );
            }
        }
    }
    return details.join(' · ');
}

function restoreState(value: unknown): SavedState {
    const fallback: SavedState = {
        version: 1,
        query: '',
        sections: {},
        cards: {},
        scrollTop: 0,
    };
    if (!value || typeof value !== 'object') return fallback;
    const v = value as Partial<SavedState>;
    if (v.version !== 1) return fallback;
    const flags = (input: unknown): Record<string, boolean> => {
        const result: Record<string, boolean> = Object.create(null);
        if (input && typeof input === 'object') {
            for (const [key, flag] of Object.entries(input)) {
                if (typeof flag === 'boolean') result[key] = flag;
            }
        }
        return result;
    };
    const cards = flags(v.cards);
    for (const [key, open] of Object.entries(cards)) {
        if (!key.startsWith('[')) continue;
        try {
            const legacy: unknown = JSON.parse(key);
            if (
                Array.isArray(legacy) &&
                legacy.length === 2 &&
                typeof legacy[1] === 'string'
            ) {
                cards[legacy[1]] ??= open;
                delete cards[key];
            }
        } catch {
            delete cards[key];
        }
    }
    return {
        version: 1,
        query: typeof v.query === 'string' ? v.query : '',
        sections: flags(v.sections),
        cards,
        scrollTop:
            typeof v.scrollTop === 'number' && Number.isFinite(v.scrollTop)
                ? Math.max(0, v.scrollTop)
                : 0,
    };
}

export function mountBoard(
    host: HTMLElement,
    post: (message: BoardMessage) => void,
    state?: { getState(): unknown; setState(value: unknown): void },
): { update(message: BoardUpdate): void; dispose(): void } {
    const doc = host.ownerDocument;
    const window = doc.defaultView;
    if (!window) throw new Error('一覧を表示するウィンドウがありません');
    const saved = restoreState(state?.getState());
    const sections = new Map<string, SectionView>();
    const clickActions = new WeakMap<HTMLElement, () => void>();
    const openKeys = new WeakMap<
        HTMLElement,
        { kind: 'sections' | 'cards'; key: string }
    >();
    let busy = false;
    let unavailable = false;
    let disposed = false;
    let hasSnapshot = false;
    const countButtons = new Map<string, HTMLButtonElement>();
    let supervisorButton: HTMLButtonElement | undefined;
    let warningSignature = '';
    const make = <K extends keyof HTMLElementTagNameMap>(
        tag: K,
        className = '',
        text = '',
    ) => {
        const node = doc.createElement(tag);
        node.className = className;
        node.textContent = text;
        return node;
    };
    const setText = (node: HTMLElement, text: string) => {
        if (node.textContent !== text) node.textContent = text;
    };
    const root = make('main', 'board');
    const header = make('header', 'board-header');
    const headingRow = make('div', 'heading-row');
    const title = make('h1', '', '進行中タスク');
    const refresh = make('button', 'refresh', '更新');
    refresh.type = 'button';
    clickActions.set(refresh, () => post({ type: 'refresh' }));
    headingRow.append(title, refresh);
    const metadata = make('p', 'metadata', '一覧を読み込んでいます…');
    const supervisor = make('div', 'supervisor');
    const counts = make('nav', 'counts');
    counts.setAttribute('aria-label', '一覧の件数と移動');
    const filterLabel = make('label', 'filter-label', '一覧を検索');
    const filter = make('input', 'filter');
    filter.type = 'search';
    filter.placeholder = 'ID・要約・本文・状態';
    filter.value = saved.query;
    filter.setAttribute('aria-label', '一覧を検索');
    filterLabel.append(filter);
    header.append(headingRow, metadata, supervisor, counts, filterLabel);
    const status = make('p', 'status');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    status.hidden = true;
    const warnings = make('aside', 'warnings');
    warnings.setAttribute('aria-label', '読み取りの注意');
    warnings.hidden = true;
    const content = make('div', 'sections');
    const empty = make('p', 'board-empty', '表示する項目はありません。');
    empty.hidden = true;
    root.append(header, status, warnings, content, empty);
    host.append(root);

    const scrollElement = () => doc.scrollingElement ?? doc.documentElement;
    const persist = () => {
        if (disposed) return;
        saved.scrollTop = host.scrollTop || scrollElement().scrollTop;
        state?.setState({
            ...saved,
            sections: { ...saved.sections },
            cards: { ...saved.cards },
        });
    };
    const jumpToSection = (id: string) => {
        const section = sections.get(id);
        if (!section) return;
        section.node.open = true;
        saved.sections[id] = true;
        section.node.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
        section.node.querySelector('summary')?.focus({ preventScroll: true });
        persist();
    };
    const followLink = (link: BoardLink) => {
        if (link.target.kind !== 'task') {
            post({ type: 'open', linkId: link.id });
            return;
        }
        const targetId = link.target.id;
        for (const [sectionId, section] of sections) {
            const card =
                section.cards.get(targetId) ??
                section.cards.get(`task:${targetId}`);
            if (!card) continue;
            filter.value = '';
            saved.query = '';
            applyFilter();
            section.node.open = true;
            card.node.open = true;
            saved.sections[sectionId] = true;
            saved.cards[card.node.dataset.cardId ?? targetId] = true;
            card.node.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
            card.summary.focus({ preventScroll: true });
            persist();
            return;
        }
        status.hidden = false;
        status.dataset.state = 'warning';
        status.textContent = `${targetId} は現在の一覧にありません。`;
    };
    const linkButton = (link: BoardLink, text = link.label) => {
        const button = make('button', 'text-link', text);
        button.type = 'button';
        button.title = link.label;
        clickActions.set(button, () => followLink(link));
        return button;
    };
    const syncOperationButtons = () => {
        for (const button of root.querySelectorAll<HTMLButtonElement>(
            '.operation',
        )) {
            button.disabled = busy || unavailable;
        }
    };
    const setBusy = (value: boolean) => {
        busy = value;
        root.setAttribute('aria-busy', String(value));
        syncOperationButtons();
    };
    const sendOperation = (operation: BoardOperation) => {
        if (busy || unavailable || !operations.has(operation.operation)) return;
        setBusy(true);
        status.hidden = false;
        status.dataset.state = 'busy';
        status.textContent = '処理中 — 確認画面と記録結果を待っています。';
        post({
            type: 'operation',
            operation: operation.operation,
            id: operation.id,
            revision: operation.revision,
        });
    };
    function applyFilter() {
        const query = filter.value.trim().toLocaleLowerCase();
        let visible = 0;
        for (const section of sections.values()) {
            let count = 0;
            for (const card of section.cards.values()) {
                card.node.hidden =
                    Boolean(query) &&
                    !card.node.textContent?.toLocaleLowerCase().includes(query);
                if (!card.node.hidden) count++;
            }
            section.empty.hidden = count !== 0;
            section.empty.textContent = query
                ? '検索に一致する項目はありません。'
                : unavailable
                  ? '前回の取得時点で該当する項目はありません。'
                  : '現在、該当する項目はありません。';
            section.count.textContent = query
                ? `${count} / ${section.cards.size}件`
                : `${section.cards.size}件`;
            visible += count;
        }
        empty.hidden = !hasSnapshot || unavailable || visible > 0;
        empty.textContent = query
            ? '検索に一致する項目はありません。'
            : '表示する項目はありません。';
    }
    const createCard = (card: BoardCard): CardView => {
        const node = make('details', 'card');
        node.dataset.cardId = card.id;
        const key = card.id;
        node.open = saved.cards[key] ?? false;
        openKeys.set(node, { kind: 'cards', key });
        const summary = make('summary', 'card-summary');
        const id = make('span', 'card-id');
        const badge = make('span', 'badge');
        const title = make('span', 'card-title');
        const excerpt = make('span', 'card-excerpt');
        summary.append(id, badge, title, excerpt);
        const body = make('div', 'card-body');
        const fields = make('dl', 'fields');
        const links = make('div', 'card-links');
        const ops = make('div', 'operations');
        body.append(fields, links, ops);
        node.append(summary, body);
        return {
            node,
            summary,
            id,
            badge,
            title,
            excerpt,
            fields,
            links,
            operations: ops,
            signature: '',
        };
    };
    const patchCard = (view: CardView, card: BoardCard) => {
        const signature = JSON.stringify(card);
        if (signature === view.signature) return;
        view.signature = signature;
        view.node.dataset.tone = card.tone ?? 'normal';
        setText(view.id, card.id);
        view.id.hidden = !/^(?:T\d+|U\d+[A-Z]*)$/.test(card.id);
        setText(view.badge, card.badge ?? '');
        view.badge.hidden = !card.badge;
        setText(view.title, card.title);
        setText(view.excerpt, card.summary);
        view.excerpt.hidden =
            !card.summary.trim() || card.summary.trim() === card.title.trim();
        const placeChildren = (
            parent: HTMLElement,
            children: HTMLElement[],
        ) => {
            children.forEach((child, index) => {
                if (parent.children[index] !== child)
                    parent.insertBefore(child, parent.children[index] ?? null);
            });
            for (const child of Array.from(parent.children)) {
                if (!children.includes(child as HTMLElement)) child.remove();
            }
        };
        const fieldNodes = card.fields.map((field, index) => {
            const row =
                (view.fields.children[index] as HTMLElement | undefined) ??
                make('div', 'field');
            let label = row.querySelector('dt');
            let value = row.querySelector('dd');
            if (!label || !value) {
                label = make('dt');
                value = make('dd');
                row.append(label, value);
            }
            setText(label, field.label);
            const tag = field.pre ? 'PRE' : 'DIV';
            let text = value.firstElementChild as HTMLElement | null;
            if (text?.tagName !== tag) {
                text = make(field.pre ? 'pre' : 'div', 'field-value');
                value.replaceChildren(text);
            }
            const partNodes = field.parts.map((part, partIndex) => {
                const tag = part.link ? 'BUTTON' : part.code ? 'CODE' : 'SPAN';
                let node = text.children[partIndex] as HTMLElement | undefined;
                if (node?.tagName !== tag)
                    node = make(
                        part.link ? 'button' : part.code ? 'code' : 'span',
                    );
                setText(node, part.text);
                if (part.link) {
                    const link = part.link;
                    node.className = 'text-link';
                    (node as HTMLButtonElement).type = 'button';
                    node.title = link.label;
                    clickActions.set(node, () => followLink(link));
                }
                return node;
            });
            placeChildren(text, partNodes);
            return row;
        });
        placeChildren(view.fields, fieldNodes);
        const links = card.links.map((link, index) => {
            const button =
                (view.links.children[index] as HTMLButtonElement | undefined) ??
                linkButton(link);
            setText(button, link.label);
            button.title = link.label;
            clickActions.set(button, () => followLink(link));
            return button;
        });
        placeChildren(view.links, links);
        view.links.hidden = card.links.length === 0;
        const previousButtons = new Map(
            Array.from(
                view.operations.querySelectorAll<HTMLButtonElement>('button'),
            ).map((button) => [button.dataset.operation, button]),
        );
        const buttons: HTMLButtonElement[] = [];
        for (const operation of card.operations) {
            if (!operations.has(operation.operation)) continue;
            const button =
                previousButtons.get(operation.operation) ??
                make('button', 'operation');
            button.type = 'button';
            button.dataset.operation = operation.operation;
            setText(button, operation.label);
            button.disabled = busy || unavailable;
            clickActions.set(button, () => sendOperation(operation));
            buttons.push(button);
        }
        for (let index = 0; index < buttons.length; index++) {
            if (view.operations.children[index] !== buttons[index])
                view.operations.insertBefore(
                    buttons[index],
                    view.operations.children[index] ?? null,
                );
        }
        for (const child of Array.from(view.operations.children)) {
            if (!buttons.includes(child as HTMLButtonElement)) child.remove();
        }
        view.operations.hidden = buttons.length === 0;
    };
    const createSection = (section: BoardSection): SectionView => {
        const node = make('details', 'board-section');
        node.dataset.sectionId = section.id;
        node.open = saved.sections[section.id] ?? section.defaultOpen;
        openKeys.set(node, { kind: 'sections', key: section.id });
        const summary = make('summary', 'section-summary');
        const title = make('h2');
        const count = make('span', 'section-count');
        summary.append(title, count);
        const description = make('p', 'section-description');
        const list = make('div', 'card-list');
        const empty = make('p', 'section-empty');
        node.append(summary, description, list, empty);
        return {
            node,
            title,
            count,
            description,
            list,
            empty,
            cards: new Map(),
        };
    };
    const render = (next: BoardSnapshot) => {
        const firstSnapshot = !hasSnapshot;
        hasSnapshot = true;
        const wasUnavailable = unavailable;
        unavailable = next.userActions?.status === 'unavailable';
        const previousCards = new Map<string, CardView>();
        for (const section of sections.values()) {
            for (const [id, card] of section.cards) {
                previousCards.set(id, card);
                saved.cards[id] = card.node.open;
            }
        }
        const nextCardIds = new Set(
            next.sections.flatMap((section) =>
                section.cards.map((card) => card.id),
            ),
        );
        for (const id of Object.keys(saved.cards)) {
            if (!nextCardIds.has(id)) delete saved.cards[id];
        }
        const focused =
            doc.activeElement instanceof window.HTMLElement
                ? doc.activeElement
                : null;
        const focusedCard = focused?.closest('.card');
        const focusedSectionId =
            focused?.closest<HTMLElement>('.board-section')?.dataset.sectionId;
        let expandedForFocus = false;
        const scrolls: [Element, number, number][] = [
            host,
            scrollElement(),
            ...root.querySelectorAll('pre'),
        ].map((node) => [node, node.scrollTop, node.scrollLeft]);
        setText(metadata, describeSnapshot(next));
        metadata.hidden = false;
        if (firstSnapshot && status.dataset.state === 'failed') {
            status.hidden = true;
            status.textContent = '';
        }
        if (next.supervisor) {
            const link = next.supervisor;
            supervisorButton ??= linkButton(link);
            setText(supervisorButton, `監督: ${link.label}`);
            supervisorButton.title = link.label;
            clickActions.set(supervisorButton, () => followLink(link));
            if (!supervisorButton.isConnected)
                supervisor.append(supervisorButton);
        } else {
            supervisorButton?.remove();
            supervisorButton = undefined;
        }
        const countKeys = new Set<string>();
        next.counts.forEach((count, index) => {
            const key = JSON.stringify([count.section, count.label]);
            countKeys.add(key);
            const button =
                countButtons.get(key) ?? make('button', 'count-link');
            countButtons.set(key, button);
            button.type = 'button';
            setText(button, `${count.label} ${count.value}件`);
            clickActions.set(button, () => jumpToSection(count.section));
            if (counts.children[index] !== button)
                counts.insertBefore(button, counts.children[index] ?? null);
        });
        for (const [key, button] of countButtons) {
            if (!countKeys.has(key)) {
                button.remove();
                countButtons.delete(key);
            }
        }
        const nextWarningSignature = JSON.stringify(next.warnings);
        if (warningSignature !== nextWarningSignature) {
            warningSignature = nextWarningSignature;
            warnings.replaceChildren(
                ...next.warnings.map((warning) => make('p', '', warning)),
            );
        }
        warnings.hidden = next.warnings.length === 0;
        const ids = new Set(next.sections.map((section) => section.id));
        for (const [id, section] of sections) {
            if (!ids.has(id)) {
                section.node.remove();
                sections.delete(id);
            }
        }
        next.sections.forEach((section, index) => {
            const view = sections.get(section.id) ?? createSection(section);
            sections.set(section.id, view);
            setText(view.title, section.title);
            setText(view.description, section.description ?? '');
            view.description.hidden = !section.description;
            const ids = new Set(section.cards.map((card) => card.id));
            for (const [id, card] of view.cards) {
                if (!ids.has(id)) {
                    if (!nextCardIds.has(id)) card.node.remove();
                    view.cards.delete(id);
                }
            }
            section.cards.forEach((card, cardIndex) => {
                const row = previousCards.get(card.id) ?? createCard(card);
                view.cards.set(card.id, row);
                if (
                    row.node === focusedCard &&
                    focusedSectionId &&
                    focusedSectionId !== section.id
                ) {
                    view.node.open = true;
                    saved.sections[section.id] = true;
                    expandedForFocus = true;
                }
                patchCard(row, card);
                if (view.list.children[cardIndex] !== row.node)
                    view.list.insertBefore(
                        row.node,
                        view.list.children[cardIndex] ?? null,
                    );
            });
            if (content.children[index] !== view.node)
                content.insertBefore(
                    view.node,
                    content.children[index] ?? null,
                );
        });
        applyFilter();
        if (wasUnavailable !== unavailable) syncOperationButtons();
        for (const [node, top, left] of scrolls) {
            node.scrollTop = top;
            node.scrollLeft = left;
        }
        if (focused?.isConnected && doc.activeElement !== focused)
            focused.focus({ preventScroll: true });
        if (firstSnapshot) {
            host.scrollTop = saved.scrollTop;
            scrollElement().scrollTop = saved.scrollTop;
        }
        if (expandedForFocus) persist();
    };
    const onClick = (event: Event) => {
        const target = event.target;
        if (!(target instanceof window.Element)) return;
        const button = target.closest<HTMLElement>('button');
        if (button && root.contains(button)) clickActions.get(button)?.();
    };
    const onToggle = (event: Event) => {
        const target = event.target;
        if (!(target instanceof window.HTMLDetailsElement)) return;
        const key = openKeys.get(target);
        if (key) {
            saved[key.kind][key.key] = target.open;
            persist();
        }
    };
    const onInput = () => {
        saved.query = filter.value;
        applyFilter();
        persist();
    };
    root.addEventListener('click', onClick);
    root.addEventListener('toggle', onToggle, true);
    filter.addEventListener('input', onInput);
    doc.addEventListener('scroll', persist, true);
    post({ type: 'ready' });
    return {
        update(message) {
            if (disposed) return;
            if (message.type === 'snapshot') render(message.snapshot);
            else {
                setBusy(message.busy ?? false);
                if (!hasSnapshot) metadata.hidden = Boolean(message.failed);
                status.hidden = !message.message;
                status.dataset.state = message.failed
                    ? 'failed'
                    : message.busy
                      ? 'busy'
                      : message.state === 'pending'
                        ? 'pending'
                        : message.state === 'error'
                          ? 'error'
                          : (message.state ?? 'info');
                status.textContent = message.message;
            }
        },
        dispose() {
            if (disposed) return;
            persist();
            disposed = true;
            root.removeEventListener('click', onClick);
            root.removeEventListener('toggle', onToggle, true);
            filter.removeEventListener('input', onInput);
            doc.removeEventListener('scroll', persist, true);
            root.remove();
            sections.clear();
        },
    };
}
