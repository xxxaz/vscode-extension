import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { type Action, candidates, kind, revision } from './boardClient.ts';
import type {
    BoardCard,
    BoardField,
    BoardLink,
    BoardSection,
    BoardSnapshot,
    BoardTarget,
    BoardText,
} from './dashboardTypes.ts';

const STATUSES = [
    'ユーザー待ち',
    'FB対応中',
    '実装中',
    'セルフレビュー中',
    '調査中',
    '提出中',
    'マージ待ち',
    '未着手',
    '保留',
    '完了',
];
const JIRA_BASE = 'https://my-atlassian-site-769979.atlassian.net';
const LOCAL_TASKS = '.agents/ローカルタスク';
const BOARD_DIR = `${LOCAL_TASKS}/監督`;
const EVENT_LABEL: Record<string, string> = {
    'user-withdraw': '依頼取り下げ',
    'user-restore': '依頼復元',
    status: 'ステータス',
    'user-action': '実行依頼',
    'user-done': '実行完了',
    jira: 'Jira',
    pr: 'PR',
    branch: 'ブランチ',
    session: 'セッション',
    note: 'メモ',
    import: 'インポート',
    archive: 'アーカイブ',
};
const TIME_FORMAT = new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
});
const time = (at: number): string => TIME_FORMAT.format(at);
type Row = Record<string, unknown>;
interface SessionRef {
    cli: 'claude' | 'codex';
    id: string;
    role?: string;
}
interface Task {
    id: string;
    title: string;
    status: string;
    statusNote?: string;
    statusNoteAt?: number;
    tickets: string[];
    branches: string[];
    prs: number[];
    sessions: SessionRef[];
    related: string[];
    notes: string[];
    imported?: boolean;
    createdAt: number;
    updatedAt: number;
    completedAt?: number;
    archivedAt?: number;
}
interface Request extends Action {
    createdAt: number;
    answer?: string;
    doneAt?: number;
}
interface Event {
    at: number;
    taskId: string;
    kind: string;
    text: string;
    by: string;
    report?: boolean;
}
interface Session extends SessionRef {
    state: string;
    updatedAt: number;
    name?: string;
    title?: string;
    model?: string;
    cwd?: string;
    branch?: string;
    firstPrompt?: string;
    lastPrompt?: string;
    lastReport?: string;
    matches?: string[];
}
interface Comment {
    at: number;
    author: string;
    text: string;
}
interface Branch {
    name: string;
    head: string;
    subject: string;
    committedAt: number;
    pushed: boolean;
    ahead?: number;
    mergedDevelop: boolean;
}
interface Pr {
    number: number;
    title: string;
    state: string;
    isDraft: boolean;
    url: string;
    headRef: string;
    headOid: string;
    labels: string[];
    commentCount: number;
    reviewCount: number;
    checks?: string;
    mergeable?: string;
    lastComment?: Comment;
}
interface Jira {
    key: string;
    summary: string;
    status: string;
    commentCount: number;
    url?: string;
    lastComment?: Comment;
}
interface Facts {
    at?: number;
    sessions: Record<string, Session>;
    branches: Record<string, Branch>;
    prs: Record<string, Pr>;
    jira: Record<string, Jira>;
    prsByBranch: Record<string, number[]>;
    worktrees: { rel: string; branch?: string; head: string }[];
    dirty: Record<string, number>;
    past: Record<string, Session[]>;
    pastTotal: Record<string, number>;
    pastFetchedAt?: number;
}

function object(value: unknown): Row {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error('オブジェクトが必要です');
    return value as Row;
}
function str(value: unknown): string {
    if (typeof value !== 'string') throw new Error('文字列が必要です');
    return value;
}
function num(value: unknown): number {
    if (
        typeof value !== 'number' ||
        !Number.isFinite(value) ||
        Math.abs(value) > 8.64e15
    )
        throw new Error('有効な数値が必要です');
    return value;
}
function bool(value: unknown): boolean {
    if (typeof value !== 'boolean') throw new Error('真偽値が必要です');
    return value;
}
function array<T>(value: unknown, parse: (v: unknown) => T): T[] {
    if (!Array.isArray(value)) throw new Error('配列が必要です');
    return value.map(parse);
}
function opt<T>(value: unknown, parse: (v: unknown) => T): T | undefined {
    return value === undefined ? undefined : parse(value);
}
const strings = (v: unknown): string[] => array(v, str);
const numbers = (v: unknown): number[] => array(v, num);
function ref(value: unknown): SessionRef {
    const r = object(value),
        cli = str(r.cli);
    if (cli !== 'claude' && cli !== 'codex') throw new Error('未対応のCLIです');
    return { cli, id: str(r.id), role: opt(r.role, str) };
}
function task(value: unknown): Task {
    const r = object(value),
        id = str(r.id),
        status = str(r.status);
    if (!/^T\d+$/.test(id) || !STATUSES.includes(status))
        throw new Error('タスクIDまたはステータスが不正です');
    return {
        id,
        title: str(r.title),
        status,
        statusNote: opt(r.statusNote, str),
        statusNoteAt: opt(r.statusNoteAt, num),
        tickets: strings(r.tickets),
        branches: strings(r.branches),
        prs: numbers(r.prs),
        sessions: array(r.sessions, ref),
        related: strings(r.related),
        notes: strings(r.notes),
        imported: opt(r.imported, bool),
        createdAt: num(r.createdAt),
        updatedAt: num(r.updatedAt),
        completedAt: opt(r.completedAt, num),
        archivedAt: opt(r.archivedAt, num),
    };
}
function request(value: unknown): Request {
    const r = object(value);
    if (!/^U\d+[A-Z]*$/.test(str(r.id))) throw new Error('依頼IDが不正です');
    str(r.text);
    bool(r.done);
    num(r.createdAt);
    for (const key of [
        'taskId',
        'summary',
        'command',
        'doc',
        'holdReason',
        'answer',
    ])
        opt(r[key], str);
    for (const key of ['ranAt', 'doneAt', 'priority']) opt(r[key], num);
    opt(r.needsOk, bool);
    opt(r.after, strings);
    if (r.kind !== undefined && r.kind !== 'execution' && r.kind !== 'decision')
        throw new Error('依頼種別が不正です');
    // revision は属性の順序と追加属性も含めるため、検証済みの原票を保持する。
    return r as unknown as Request;
}
function event(value: unknown): Event {
    const r = object(value);
    return {
        at: num(r.at),
        taskId: str(r.taskId),
        kind: str(r.kind),
        text: str(r.text),
        by: str(r.by),
        report: opt(r.report, bool),
    };
}
function comment(value: unknown): Comment {
    const r = object(value);
    return { at: num(r.at), author: str(r.author), text: str(r.text) };
}
function session(value: unknown): Session {
    const r = object(value);
    return {
        ...ref(r),
        state: str(r.state),
        updatedAt: num(r.updatedAt),
        name: opt(r.name, str),
        title: opt(r.title, str),
        model: opt(r.model, str),
        cwd: opt(r.cwd, str),
        branch: opt(r.branch, str),
        firstPrompt: opt(r.firstPrompt, str),
        lastPrompt: opt(r.lastPrompt, str),
        lastReport: opt(r.lastReport, str),
        matches: opt(r.matches, strings),
    };
}
function branch(value: unknown): Branch {
    const r = object(value);
    return {
        name: str(r.name),
        head: str(r.head),
        subject: str(r.subject),
        committedAt: num(r.committedAt),
        pushed: bool(r.pushed),
        ahead: opt(r.ahead, num),
        mergedDevelop: bool(r.mergedDevelop),
    };
}
function pr(value: unknown): Pr {
    const r = object(value),
        state = str(r.state);
    if (!['OPEN', 'MERGED', 'CLOSED'].includes(state))
        throw new Error('PR状態が不正です');
    return {
        number: num(r.number),
        title: str(r.title),
        state,
        isDraft: bool(r.isDraft),
        url: str(r.url),
        headRef: str(r.headRef),
        headOid: str(r.headOid),
        labels: strings(r.labels),
        commentCount: num(r.commentCount),
        reviewCount: num(r.reviewCount),
        checks: opt(r.checks, str),
        mergeable: opt(r.mergeable, str),
        lastComment: opt(r.lastComment, comment),
    };
}
function jira(value: unknown): Jira {
    const r = object(value);
    return {
        key: str(r.key),
        summary: str(r.summary),
        status: str(r.status),
        commentCount: num(r.commentCount),
        url: opt(r.url, str),
        lastComment: opt(r.lastComment, comment),
    };
}
function uniqueIds(rows: { id: string }[]): void {
    if (new Set(rows.map((r) => r.id)).size !== rows.length)
        throw new Error('IDが重複しています');
}
function readFacts(value: unknown, warnings: string[]): Facts {
    const r = value === undefined ? {} : object(value);
    const map = <T>(
        key: string,
        parse: (v: unknown) => T,
    ): Record<string, T> => {
        const result: Record<string, T> = Object.create(null);
        if (r[key] === undefined) return result;
        for (const [id, v] of Object.entries(object(r[key]))) {
            try {
                result[id] = parse(v);
            } catch {
                warnings.push(`事実キャッシュ ${key}/${id} の形式が不正です`);
            }
        }
        return result;
    };
    const worktrees: Facts['worktrees'] = [];
    for (const v of array(r.worktrees ?? [], (x) => x)) {
        try {
            const w = object(v);
            worktrees.push({
                rel: str(w.rel),
                branch: opt(w.branch, str),
                head: str(w.head),
            });
        } catch {
            warnings.push('事実キャッシュ worktrees の形式が不正です');
        }
    }
    return {
        at: opt(r.at, num),
        sessions: map('sessions', session),
        branches: map('branches', branch),
        prs: map('prs', pr),
        jira: map('jira', jira),
        prsByBranch: map('prsByBranch', numbers),
        worktrees,
        dirty: map('dirty', num),
        past: map('past', (v) => array(v, session)),
        pastTotal: map('pastTotal', num),
        pastFetchedAt: opt(r.pastFetchedAt, num),
    };
}

function hold(a: Request, actions: Request[]): string | undefined {
    const waiting = (a.after ?? []).filter((id) =>
        actions.some((other) => other.id === id && !other.done),
    );
    return (
        [
            a.holdReason,
            ...(waiting.length
                ? [`前提 ${waiting.join('・')} の完了待ち`]
                : []),
        ]
            .filter((s) => s !== undefined && s !== '')
            .join(' / ') || undefined
    );
}
const sortActions = (rows: Request[]): Request[] =>
    [...rows].sort(
        (a, b) =>
            (a.priority ?? Number.POSITIVE_INFINITY) -
                (b.priority ?? Number.POSITIVE_INFINITY) ||
            a.createdAt - b.createdAt,
    );
const sortTasks = (rows: Task[]): Task[] =>
    [...rows].sort(
        (a, b) =>
            STATUSES.indexOf(a.status) - STATUSES.indexOf(b.status) ||
            b.updatedAt - a.updatedAt,
    );
const sessionKey = (r: SessionRef): string => `${r.cli}:${r.id}`;
const sameSession = (a: SessionRef, b: SessionRef): boolean =>
    a.cli === b.cli && a.id === b.id;
const conflict = (p: Pr): boolean =>
    p.state === 'OPEN' && p.mergeable === 'CONFLICTING';
const prState = (p: Pr): string =>
    p.state !== 'OPEN'
        ? p.state === 'MERGED'
            ? 'マージ済み'
            : 'クローズ'
        : p.labels.includes('マージ保留')
          ? `マージ保留${p.isDraft ? ' (Draft)' : ''}`
          : p.isDraft
            ? 'Draft'
            : 'Open';
function pendingBranches(t: Task, f: Facts): string[] {
    return t.branches.filter((name) => {
        const b = f.branches[name];
        if (!b || b.mergedDevelop) return false;
        const prs = t.prs
            .map((n) => f.prs[n])
            .filter((p) => p !== undefined && p.headRef === name);
        if (prs.some((p) => p.state === 'OPEN')) return false;
        return (
            !prs.some((p) => p.state === 'MERGED') ||
            (b.pushed && (b.ahead ?? 0) > 0)
        );
    });
}
const REVIEW_LABEL_STATE = [
    ['セルフレビュー：FB修正待ち', 'FB修正待ち'],
    ['マージレビュー：FB済み', 'FB済み'],
    ['セルフレビュー：提出中', 'セルフレビュー提出中'],
    ['マージレビュー：判断待ち', 'マージレビュー判断待ち'],
    ['マージレビュー：確認待ち', 'マージレビュー確認待ち'],
    ['マージレビュー：統合待ち', '統合待ち'],
    ['マージレビュー：マージ中', 'マージ中'],
];
function factsLine(t: Task, f: Facts): string | undefined {
    const parts: string[] = [];
    for (const p of t.prs
        .map((n) => f.prs[n])
        .filter((p) => p?.state === 'OPEN')) {
        const state = REVIEW_LABEL_STATE.find(([label]) =>
            p.labels.includes(label),
        )?.[1];
        const flags = [
            ...(conflict(p) ? ['ベースと衝突'] : []),
            ...(['FAILURE', 'ERROR'].includes(p.checks ?? '')
                ? ['CI 失敗']
                : []),
        ];
        parts.push(
            `PR #${p.number}${state ? ` ${state}` : ' Open'}${flags.length ? `（${flags.join('・')}）` : ''}`,
        );
    }
    for (const name of pendingBranches(t, f)) {
        const b = f.branches[name];
        const prs = [...new Set([...t.prs, ...(f.prsByBranch[name] ?? [])])]
            .map((n) => f.prs[n])
            .filter((p) => p !== undefined && p.headRef === name);
        const state = !b?.pushed
            ? '未 push'
            : b.ahead && b.ahead > 0
              ? `未 push ${b.ahead} 件`
              : prs.length
                ? 'PR 閉じ済み'
                : f.prsByBranch[name] === undefined
                  ? 'PR 未確認'
                  : 'PR 未作成';
        parts.push(`${name} ${state}`);
    }
    return parts.length ? parts.join(' / ') : undefined;
}
function statusLines(t: Task, events: Event[], f: Facts): string[] {
    const line = factsLine(t, f);
    if (['保留', 'ユーザー待ち'].includes(t.status) && t.statusNote)
        return [t.statusNote, ...(line ? [line] : [])];
    const since =
        t.statusNoteAt ??
        (t.statusNote === undefined
            ? 0
            : (events
                  .filter(
                      (e) =>
                          e.taskId === t.id &&
                          e.kind === 'status' &&
                          e.by !== '自動検出' &&
                          e.text.includes(t.statusNote ?? ''),
                  )
                  .at(-1)?.at ?? 0));
    const log = events
        .filter(
            (e) =>
                e.taskId === t.id &&
                e.kind === 'note' &&
                e.at > since &&
                (e.report ||
                    (/^(?:claude|codex):/.test(e.by) &&
                        !/^紐づけ(?:追加|削除)/.test(e.text) &&
                        !/^U\d+ /.test(e.text))),
        )
        .at(-1);
    const s = t.sessions
        .map((r) => f.sessions[sessionKey(r)])
        .filter(
            (s) =>
                s?.lastReport !== undefined &&
                s.updatedAt > since &&
                !t.sessions.some(
                    (r) => sameSession(r, s) && r.role === 'レビュー役',
                ),
        )
        .sort((a, b) => b.updatedAt - a.updatedAt)[0];
    const report =
        log && (!s || log.at >= s.updatedAt)
            ? { at: log.at, text: log.text, session: false }
            : s?.lastReport
              ? { at: s.updatedAt, text: s.lastReport, session: true }
              : undefined;
    if (!report) return t.statusNote ? [t.statusNote] : line ? [line] : [];
    const first =
        report.text
            .split('\n')
            .map((l) =>
                l
                    .replace(/^[\s>#*\-・]+/, '')
                    .replace(/[*`]/g, '')
                    .trim(),
            )
            .find((l) => l !== '') ?? '';
    const chars = [...first.replace(/\s+/g, ' ').trim()];
    const headline =
        chars.length > 140
            ? `${chars.slice(0, 139).join('')}…`
            : chars.join('');
    return [
        `${time(report.at)} ${report.session ? 'セッションの直近の発言: ' : ''}${headline}`,
        ...(line ? [line] : []),
    ];
}
function looksDone(t: Task, f: Facts, actions: Request[]): boolean {
    if (
        actions.some(
            (a) => a.taskId === t.id && !a.done && a.withdrawal === undefined,
        ) ||
        pendingBranches(t, f).length
    )
        return false;
    const prs = t.prs.map((n) => f.prs[n]);
    return prs.length
        ? prs.every((p) => p !== undefined && p.state !== 'OPEN') &&
              prs.some((p) => p?.state === 'MERGED')
        : t.branches.length > 0 &&
              t.branches.every((b) => f.branches[b]?.mergedDevelop === true);
}

function link(id: string, label: string, target: BoardTarget): BoardLink {
    return { id, label, target };
}
const text = (value: string): BoardText => ({ text: value });
const linked = (value: BoardLink): BoardText => ({
    text: value.label,
    link: value,
});
const field = (label: string, ...parts: BoardText[]): BoardField => ({
    label,
    parts,
});
function fileLink(
    id: string,
    label: string,
    path: string,
): BoardLink | undefined {
    const normalized = posix.normalize(path.replace(/^(\.\/)+/, ''));
    return normalized.startsWith('/') ||
        normalized === '..' ||
        normalized.startsWith('../')
        ? undefined
        : link(id, label, { kind: 'file', path: normalized });
}
function external(
    id: string,
    label: string,
    uri: string,
): BoardLink | undefined {
    try {
        const url = new URL(uri);
        if (!['https:', 'http:', 'vscode:'].includes(url.protocol))
            return undefined;
        return link(id, label, { kind: 'external', uri });
    } catch {
        return undefined;
    }
}
function jiraLink(id: string, key: string, f: Facts): BoardLink | undefined {
    return /^[A-Z][A-Z0-9]*-\d+$/.test(key)
        ? external(id, key, f.jira[key]?.url ?? `${JIRA_BASE}/browse/${key}`)
        : undefined;
}
const withLink = (l: BoardLink | undefined, fallback: string): BoardText =>
    l ? linked(l) : text(fallback);
function taskLink(id: string, t: Task): BoardLink {
    return link(id, `${t.id} ${t.title}`, { kind: 'task', id: t.id });
}
function modelLabel(model: string | undefined): string {
    if (!model) return 'モデル不明';
    const m = model.match(/^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/);
    return m
        ? `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] ? `.${m[3]}` : ''}`
        : model;
}
function sessionLink(
    id: string,
    r: SessionRef,
    s?: Session,
): BoardLink | undefined {
    return r.cli === 'claude'
        ? external(
              id,
              s?.name ?? s?.title ?? r.id.slice(0, 8),
              `vscode://anthropic.claude-code/open?session=${encodeURIComponent(r.id)}`,
          )
        : undefined;
}
function sessionFields(
    prefix: string,
    r: SessionRef,
    s?: Session,
    past = false,
): BoardField[] {
    const name = `${past ? '過去の' : ''}AI・セッション ${r.cli}:${r.id}`;
    const parts = [
        text(
            `${r.cli === 'claude' ? 'Claude Code' : 'Codex'} · ${modelLabel(s?.model)}${r.role ? ` (${r.role})` : ''} · ${s?.state ?? '未取得'}`,
        ),
        withLink(
            sessionLink(`${prefix}/link`, r, s),
            s?.name ?? s?.title ?? r.id,
        ),
        text(
            `CLI: ${r.cli === 'claude' ? 'claude --resume' : 'codex resume'} ${r.id}`,
        ),
    ];
    if (s?.title) parts.push(text(`タイトル: ${s.title}`));
    if (s?.cwd !== undefined)
        parts.push(
            withLink(
                fileLink(
                    `${prefix}/cwd`,
                    `場所: ${s.cwd || 'メインの作業ツリー'}${s.branch ? ` (${s.branch})` : ''}`,
                    s.cwd || '.',
                ),
                `場所: ${s.cwd}`,
            ),
        );
    if (s?.firstPrompt) parts.push(text(`最初の依頼: ${s.firstPrompt}`));
    if (s?.lastPrompt && s.lastPrompt !== s.firstPrompt)
        parts.push(text(`直近の依頼: ${s.lastPrompt}`));
    if (s?.lastReport) parts.push(text(`直近の報告: ${s.lastReport}`));
    if (s) parts.push(text(`最終更新 ${time(s.updatedAt)}`));
    if (s?.matches?.length) parts.push(text(`一致: ${s.matches.join('・')}`));
    return [field(name, ...parts)];
}

export function projectBoard(input: {
    registry: unknown;
    archive: unknown;
    state: unknown;
    events: unknown[];
    updatedAt: number;
    source: 'legacy' | 'authoritative';
    readWarnings?: string[];
    repoUrl?: string;
}): BoardSnapshot {
    const r = object(input.registry),
        a = object(input.archive),
        state = object(input.state);
    if (r.version !== 1) throw new Error('未対応の台帳形式です');
    const tasks = array(r.tasks, task),
        archived = array(a.tasks, task),
        actions = array(r.actions, request);
    uniqueIds([...tasks, ...archived]);
    uniqueIds(actions);
    const warnings = [...(input.readWarnings ?? [])];
    const rawFacts = state.facts === undefined ? {} : object(state.facts);
    warnings.push(...strings(rawFacts.warnings ?? []));
    const facts = readFacts(rawFacts, warnings),
        events: Event[] = [];
    for (const raw of input.events) {
        try {
            events.push(event(raw));
        } catch {
            warnings.push('イベントの形式が不正なため表示できない行があります');
        }
    }
    const known = new Map([...tasks, ...archived].map((t) => [t.id, t]));
    const live = actions.filter((v) => !v.done && v.withdrawal === undefined);
    const open = sortActions(
        live.filter(
            (v) => v.ranAt === undefined && hold(v, actions) === undefined,
        ),
    );
    const held = sortActions(
        live.filter(
            (v) => v.ranAt === undefined && hold(v, actions) !== undefined,
        ),
    );
    const awaiting = sortActions(live.filter((v) => v.ranAt !== undefined));
    const eligible = {
        complete: new Set(
            candidates({ version: 1, actions }, 'complete').map((v) => v.id),
        ),
        ran: new Set(
            candidates({ version: 1, actions }, 'ran').map((v) => v.id),
        ),
        answer: new Set(
            candidates({ version: 1, actions }, 'answer').map((v) => v.id),
        ),
    };
    const section = (
        id: string,
        title: string,
        cards: BoardCard[],
        defaultOpen = true,
    ): BoardSection => ({ id, title, cards, defaultOpen });
    const actionCard = (v: Request, group: string): BoardCard => {
        const prefix = `${group}/${v.id}`,
            t = v.taskId ? known.get(v.taskId) : undefined;
        const fields = [
            field(
                '優先度',
                text(v.priority === undefined ? '未指定' : String(v.priority)),
            ),
            field(
                'タスク',
                t
                    ? linked(taskLink(`${prefix}/task`, t))
                    : text(v.taskId ? `${v.taskId} (削除済み)` : '紐づけなし'),
            ),
            field('依頼の全文', text(v.text)),
            field('依頼日時', text(time(v.createdAt))),
        ];
        if (v.command !== undefined)
            fields.push({
                label: 'コマンド・手順',
                parts: [text(v.command)],
                pre: true,
            });
        if (v.doc)
            fields.push(
                field(
                    '資料',
                    withLink(
                        /^https?:\/\//i.test(v.doc)
                            ? external(`${prefix}/doc`, v.doc, v.doc)
                            : fileLink(`${prefix}/doc`, v.doc, v.doc),
                        v.doc,
                    ),
                ),
            );
        if (kind(v) === 'decision')
            fields.push(field('推奨回答', text('推奨で進める')));
        if (hold(v, actions))
            fields.push(
                field('保留理由・再開条件', text(hold(v, actions) ?? '')),
            );
        if (v.ranAt !== undefined)
            fields.push(
                field('実行済み', text(`${time(v.ranAt)}・結果の確認待ち`)),
            );
        if (v.needsOk)
            fields.push(field('完了条件', text('結果を確認して OK なら完了')));
        if (v.after?.length)
            fields.push(field('前提', text(v.after.join('・'))));
        const operations: BoardCard['operations'] =
            group === 'held'
                ? []
                : (['complete', 'ran', 'answer'] as const)
                      .filter((operation) => eligible[operation].has(v.id))
                      .map((operation) => ({
                          operation,
                          id: v.id,
                          revision: revision(v),
                          label:
                              operation === 'complete'
                                  ? '完了（結果確認 OK）'
                                  : operation === 'ran'
                                    ? 'キック済み'
                                    : '回答する',
                      }));
        const chars = [...v.text],
            summary =
                v.summary ||
                (chars.length > 48
                    ? `${chars.slice(0, 47).join('')}…`
                    : v.text);
        return {
            id: v.id,
            title: summary,
            summary,
            badge: `${kind(v) === 'execution' ? '実行' : '判断'} · 優先度 ${v.priority ?? '未指定'}`,
            fields,
            links: [],
            operations,
        };
    };
    const taskCard = (t: Task): BoardCard => {
        const prefix = `task/${t.id}`,
            relatedActions = live.filter((v) => v.taskId === t.id);
        const status = [
            text(`${t.status}${t.imported ? ' 🔎要確認' : ''}`),
            ...(t.status === '完了'
                ? t.statusNote
                    ? [t.statusNote]
                    : []
                : statusLines(t, events, facts)
            ).map(text),
        ];
        const taskOpen = open.filter((v) => v.taskId === t.id);
        if (taskOpen.length)
            status.push(
                text(
                    `👤 実行待ち ${taskOpen.filter((v) => kind(v) === 'execution').length} / 判断待ち ${taskOpen.filter((v) => kind(v) === 'decision').length}`,
                ),
            );
        const heldCount = held.filter((v) => v.taskId === t.id).length,
            waitingCount = relatedActions.filter(
                (v) => v.ranAt !== undefined,
            ).length;
        if (heldCount) status.push(text(`⏸ 保留中の依頼 ${heldCount}`));
        if (waitingCount)
            status.push(text(`⏳ 結果の確認待ち ${waitingCount}`));
        if (t.status !== '完了' && looksDone(t, facts, actions))
            status.push(text('✅ 完了候補'));
        if (t.status === '完了' && t.completedAt !== undefined)
            status.push(
                text(`完了 ${time(t.completedAt)}`),
                text(`アーカイブ予定 ${time(t.completedAt + 86400000)}`),
            );
        const fields: BoardField[] = [field('ステータス', ...status)];
        const last = events.filter((e) => e.taskId === t.id).at(-1);
        if (last)
            fields.push(
                field(
                    '最新イベント',
                    text(`${time(last.at)} ${last.text} (${last.by})`),
                ),
            );
        for (const key of t.tickets) {
            const j = facts.jira[key],
                parts = [
                    withLink(
                        jiraLink(`${prefix}/jira/${key}`, key, facts),
                        key,
                    ),
                ];
            if (j) {
                parts.push(
                    text(j.summary),
                    text(j.status),
                    text(`コメント ${j.commentCount} 件`),
                );
                if (j.lastComment)
                    parts.push(
                        text(
                            `最新コメント ${time(j.lastComment.at)} ${j.lastComment.author}: ${j.lastComment.text}`,
                        ),
                    );
            }
            fields.push(field('Jira', ...parts));
        }
        for (const name of t.branches) {
            const b = facts.branches[name];
            fields.push(
                field(
                    'ブランチ',
                    { text: name, code: true },
                    text(
                        b
                            ? `${b.head} ${b.mergedDevelop ? '✅ develop 済' : !b.pushed ? '未 push' : b.ahead ? `未 push ${b.ahead}` : 'push 済み'}`
                            : 'ローカルに無し',
                    ),
                    ...(b
                        ? [
                              text(b.subject),
                              text(`コミット ${time(b.committedAt)}`),
                          ]
                        : []),
                ),
            );
        }
        const wts = new Set<string>();
        for (const wt of facts.worktrees) {
            if (wt.rel === '') continue;
            if (
                (wt.branch && t.branches.includes(wt.branch)) ||
                t.sessions.some((ref) => {
                    const cwd = facts.sessions[sessionKey(ref)]?.cwd;
                    return cwd === wt.rel || cwd?.startsWith(`${wt.rel}/`);
                })
            )
                wts.add(wt.rel);
        }
        for (const rel of wts)
            fields.push(
                field(
                    'WT',
                    withLink(fileLink(`${prefix}/wt/${rel}`, rel, rel), rel),
                    text(`未コミット ${facts.dirty[rel] ?? '未取得'}`),
                ),
            );
        for (const n of t.prs) {
            const p = facts.prs[n],
                parts = [
                    withLink(
                        p
                            ? external(`${prefix}/pr/${n}`, `#${n}`, p.url)
                            : input.repoUrl
                              ? external(
                                    `${prefix}/pr/${n}`,
                                    `#${n}`,
                                    `${input.repoUrl.replace(/\/$/, '')}/pull/${n}`,
                                )
                              : undefined,
                        `#${n}`,
                    ),
                ];
            if (p) {
                parts.push(
                    text(p.title),
                    text(prState(p)),
                    text(`head ${p.headOid}`),
                    text(
                        conflict(p)
                            ? 'CI は衝突の解消後に回る (ベースと衝突)'
                            : `CI ${p.checks ?? '-'}`,
                    ),
                    text(`ラベル: ${p.labels.join(' / ')}`),
                    text(
                        `コメント ${p.commentCount} 件 / レビュー ${p.reviewCount} 件`,
                    ),
                );
                if (p.lastComment)
                    parts.push(
                        text(
                            `最新コメント ${time(p.lastComment.at)} ${p.lastComment.author}: ${p.lastComment.text}`,
                        ),
                    );
            }
            fields.push(field('PR', ...parts));
        }
        t.sessions.forEach((r, index) => {
            fields.push(
                ...sessionFields(
                    `${prefix}/session/${index}`,
                    r,
                    facts.sessions[sessionKey(r)],
                ),
            );
        });
        const supervisor = opt(r.supervisor, ref);
        const past = (facts.past[t.id] ?? []).filter(
            (s) =>
                !t.sessions.some((r) => sameSession(r, s)) &&
                !(supervisor && sameSession(supervisor, s)),
        );
        const total =
            (facts.pastTotal[t.id] ?? (facts.past[t.id] ?? []).length) -
            ((facts.past[t.id] ?? []).length - past.length);
        if (past.length)
            fields.push(
                field(
                    '過去のセッション',
                    text(
                        `${total} 件${facts.pastFetchedAt !== undefined ? ` / 取得 ${time(facts.pastFetchedAt)}` : ''}`,
                    ),
                ),
            );
        past.forEach((s, index) => {
            fields.push(
                ...sessionFields(`${prefix}/past/${index}`, s, s, true),
            );
        });
        if (t.related.length)
            fields.push(
                field(
                    '関連',
                    ...t.related.map((id, index) => {
                        const related = known.get(id),
                            l = related
                                ? taskLink(
                                      `${prefix}/related/${index}`,
                                      related,
                                  )
                                : jiraLink(
                                      `${prefix}/related/${index}`,
                                      id,
                                      facts,
                                  );
                        return withLink(
                            l,
                            /^T\d+$/.test(id) ? `${id} (削除済み)` : id,
                        );
                    }),
                ),
            );
        if (t.notes.length)
            fields.push(
                field(
                    'メモ',
                    ...t.notes.map((n, index) =>
                        withLink(
                            fileLink(
                                `${prefix}/note/${index}`,
                                n,
                                `${LOCAL_TASKS}/${n}`,
                            ),
                            n,
                        ),
                    ),
                ),
            );
        fields.push(
            field(
                '日時',
                text(
                    `作成 ${time(t.createdAt)} / 更新 ${time(t.updatedAt)}${t.completedAt !== undefined ? ` / 完了 ${time(t.completedAt)}` : ''}${t.archivedAt !== undefined ? ` / アーカイブ ${time(t.archivedAt)}` : ''}`,
                ),
            ),
        );
        return {
            id: t.id,
            title: t.title,
            summary:
                status
                    .slice(1)
                    .find((p) => p.text !== t.status)
                    ?.text.split(/\r?\n/, 1)[0] ?? '',
            badge: t.status,
            fields,
            links: [taskLink(`${prefix}/detail`, t)],
            operations: [],
        };
    };
    const sections: BoardSection[] = [
        section(
            'execution',
            '実行待ち',
            open
                .filter((v) => kind(v) === 'execution')
                .map((v) => actionCard(v, 'execution')),
        ),
        section(
            'decision',
            '判断待ち',
            open
                .filter((v) => kind(v) === 'decision')
                .map((v) => actionCard(v, 'decision')),
        ),
        section(
            'held',
            '保留・前提待ちの依頼',
            held.map((v) => actionCard(v, 'held')),
            false,
        ),
        section(
            'awaiting',
            '実行済み・結果の確認待ち',
            awaiting.map((v) => actionCard(v, 'awaiting')),
        ),
        section(
            'tasks',
            '進行中のタスク',
            sortTasks(
                tasks.filter((t) => !['保留', '完了'].includes(t.status)),
            ).map(taskCard),
        ),
        section(
            'held-tasks',
            '保留中のタスク',
            sortTasks(tasks.filter((t) => t.status === '保留')).map(taskCard),
            false,
        ),
        section(
            'completed',
            '完了済み（アーカイブ待ち）',
            tasks
                .filter((t) => t.status === '完了')
                .sort(
                    (a, b) =>
                        (b.completedAt ?? b.updatedAt) -
                        (a.completedAt ?? a.updatedAt),
                )
                .map(taskCard),
            false,
        ),
        section(
            'archive',
            'アーカイブ済みのタスク',
            [...archived]
                .sort((a, b) => (b.archivedAt ?? 0) - (a.archivedAt ?? 0))
                .map(taskCard),
            false,
        ),
    ];
    const notices: { at: number; card: BoardCard }[] = [];
    const mentions =
        state.userMentions === undefined
            ? undefined
            : object(state.userMentions);
    if (mentions)
        for (const [user, raw] of Object.entries(object(mentions.byUser))) {
            for (const [key, value] of Object.entries(
                object(object(raw).items),
            )) {
                try {
                    const item = object(value);
                    if (item.ackedAt !== undefined) {
                        num(item.ackedAt);
                        continue;
                    }
                    const at = num(item.at),
                        where = str(item.where),
                        reason = str(item.reason),
                        author = str(item.author),
                        snippet = str(item.snippet),
                        url = str(item.url);
                    const id = `notice:${createHash('sha256').update(`${user}:${key}`).digest('hex')}`;
                    const noticeLink = external(`${id}/link`, where, url);
                    notices.push({
                        at,
                        card: {
                            id,
                            title: `${where} ${reason}`,
                            summary: snippet,
                            badge: '監督の確認待ち',
                            fields: [
                                field('宛先', text(user)),
                                field('種類', text(str(item.kind))),
                                field('日時', text(time(at))),
                                field(
                                    '投稿者',
                                    text(
                                        `${author}${item.agent === true ? ' (AI)' : ''}`,
                                    ),
                                ),
                                field('内容', text(snippet)),
                            ],
                            links: noticeLink ? [noticeLink] : [],
                            operations: [],
                        },
                    });
                } catch {
                    warnings.push(
                        `監督のお知らせ ${user}/${key} の形式が不正です`,
                    );
                }
            }
        }
    sections.push(
        section(
            'notices',
            '監督のお知らせ',
            notices.sort((a, b) => a.at - b.at).map((v) => v.card),
        ),
    );
    const active = new Set(tasks.map((t) => t.id));
    const recent: (Event & { id: string })[] = [];
    for (
        let index = events.length - 1;
        index >= 0 && recent.length < 20;
        index--
    ) {
        const e = events[index];
        if (active.has(e.taskId))
            recent.push({ ...e, id: `event:${index}:${e.at}` });
    }
    sections.push(
        section(
            'events',
            '最近のイベント',
            recent.map((e) => ({
                id: e.id,
                title: `${e.taskId} ${EVENT_LABEL[e.kind] ?? e.kind}`,
                summary: e.text,
                fields: [
                    field('日時', text(time(e.at))),
                    field('内容', text(e.text)),
                    field('記録', text(e.by)),
                ],
                links: known.has(e.taskId)
                    ? [
                          link(`${e.id}/task`, e.taskId, {
                              kind: 'task',
                              id: e.taskId,
                          }),
                      ]
                    : [],
                operations: [],
            })),
            false,
        ),
    );
    const sup = opt(r.supervisor, ref),
        supFact = sup ? facts.sessions[sessionKey(sup)] : undefined;
    const supLink = sup
        ? (sessionLink('supervisor', sup, supFact) ??
          fileLink(
              'supervisor',
              `${supFact?.name ?? supFact?.title ?? 'Codex'} · codex resume ${sup.id}`,
              `${BOARD_DIR}/進行中タスク.md`,
          ))
        : undefined;
    const seenLinks = new Set<string>();
    const allLinks = [
        ...(supLink ? [supLink] : []),
        ...sections.flatMap((s) =>
            s.cards.flatMap((c) => [
                ...c.links,
                ...c.fields.flatMap((f) =>
                    f.parts.flatMap((p) => (p.link ? [p.link] : [])),
                ),
            ]),
        ),
    ];
    for (const l of allLinks) {
        const base = l.id;
        let occurrence = 1;
        while (seenLinks.has(l.id)) l.id = `${base}/${++occurrence}`;
        seenLinks.add(l.id);
    }
    return {
        schemaVersion: 1,
        source: input.source,
        updatedAt: num(input.updatedAt),
        supervisor: supLink,
        warnings: [...new Set(warnings)],
        counts: sections
            .filter((s) => s.id !== 'events')
            .map((s) => ({
                label: s.title,
                value: s.cards.length,
                section: s.id,
            })),
        sections,
    };
}
