import { isAbsolute, relative, resolve } from 'node:path';
import type {
    BoardLink,
    BoardMessage,
    BoardSnapshot,
    BoardTarget,
} from './dashboardTypes.ts';

export function isOutsideRelative(path: string): boolean {
    return path === '..' || /^\.\.[\\/]/.test(path) || isAbsolute(path);
}

export function parseBoardMessage(value: unknown): BoardMessage | undefined {
    if (!value || typeof value !== 'object' || !('type' in value)) return;
    if (value.type === 'ready' || value.type === 'refresh')
        return { type: value.type };
    if (
        value.type === 'open' &&
        'linkId' in value &&
        typeof value.linkId === 'string' &&
        value.linkId.length <= 1000
    )
        return { type: 'open', linkId: value.linkId };
    if (
        value.type === 'copy-command' &&
        'id' in value &&
        typeof value.id === 'string' &&
        /^U\d+[A-Z]*$/.test(value.id) &&
        'revision' in value &&
        typeof value.revision === 'string' &&
        /^[a-f0-9]{64}$/.test(value.revision)
    )
        return { type: 'copy-command', id: value.id, revision: value.revision };
    if (
        value.type === 'operation' &&
        'operation' in value &&
        (value.operation === 'complete' ||
            value.operation === 'ran' ||
            value.operation === 'answer') &&
        'id' in value &&
        typeof value.id === 'string' &&
        /^U\d+[A-Z]*$/.test(value.id) &&
        'revision' in value &&
        typeof value.revision === 'string' &&
        /^[a-f0-9]{64}$/.test(value.revision)
    )
        return {
            type: 'operation',
            operation: value.operation,
            id: value.id,
            revision: value.revision,
        };
}
export async function copyBoardCommand(
    snapshot: BoardSnapshot,
    message: Extract<BoardMessage, { type: 'copy-command' }>,
    clipboard: { writeText(value: string): PromiseLike<void> },
): Promise<void> {
    const command = snapshot.sections
        .flatMap((section) => section.cards)
        .find(
            (card) =>
                card.command?.id === message.id &&
                card.command.revision === message.revision,
        )?.command;
    if (!command?.text.trim())
        throw new Error(
            '一覧のコマンドが更新されました。最新の行を確認してください',
        );
    await clipboard.writeText(command.text);
}
export function findBoardLink(
    snapshot: BoardSnapshot,
    id: string,
): BoardLink | undefined {
    const links = [
        snapshot.supervisor,
        ...snapshot.sections.flatMap((section) =>
            section.cards.flatMap((card) => [
                ...card.links,
                ...card.fields.flatMap((field) =>
                    field.parts.map((part) => part.link),
                ),
            ]),
        ),
    ];
    return links.find((link) => link?.id === id);
}
export function hasBoardOperation(
    snapshot: BoardSnapshot,
    message: Extract<BoardMessage, { type: 'operation' }>,
): boolean {
    if (snapshot.userActions?.status === 'unavailable') return false;
    return snapshot.sections.some((section) =>
        section.cards.some((card) =>
            card.operations.some(
                (op) =>
                    op.id === message.id &&
                    op.revision === message.revision &&
                    op.operation === message.operation,
            ),
        ),
    );
}
export function resolveBoardTarget(
    root: string,
    target: BoardTarget,
): { file: string } | { external: string } {
    if (target.kind === 'external') {
        const uri = new URL(target.uri);
        if (uri.protocol === 'http:' || uri.protocol === 'https:')
            return { external: uri.href };
        if (
            uri.protocol === 'vscode:' &&
            uri.hostname === 'anthropic.claude-code' &&
            uri.pathname === '/open' &&
            /^[a-f\d-]{36}$/i.test(uri.searchParams.get('session') ?? '')
        )
            return { external: uri.href };
        throw new Error('この種類のリンクは開けません');
    }
    if (target.kind === 'task' && !/^T\d+$/.test(target.id))
        throw new Error('タスクIDが不正です');
    const file = resolve(
        root,
        target.kind === 'task'
            ? `.agents/ローカルタスク/監督/タスク/${target.id}.md`
            : target.path,
    );
    const inside = relative(resolve(root), file);
    if (isOutsideRelative(inside) || file.includes('\0'))
        throw new Error('ワークスペース外のファイルは開けません');
    return { file };
}
