import { randomBytes } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { projectBoard } from '../src/boardModel.ts';
import type { BoardSnapshot } from '../src/dashboardTypes.ts';
import { boardHtml } from '../src/dashboardWebview.ts';

export function sampleSnapshot(): BoardSnapshot {
    const now = Date.now();
    const statuses = [
        'ユーザー待ち',
        '実装中',
        '調査中',
        'セルフレビュー中',
        '提出中',
        'マージ待ち',
    ];
    const titles = [
        '監督一覧の全情報と行操作を確認する',
        '予約取込みの重複検知を改善する',
        '請求一覧の更新後の反映を確認する',
        'チェックイン画面の表示を整える',
        '外部連携の結果待ちを調査する',
        '精算レポートの入力条件を整理する',
        '管理画面の権限設定を確認する',
        'マイグレーションの切り戻しを検証する',
        '通知の宛先と本文を確認する',
        '検索条件を変更したときの表示を確認する',
        '料金設定の境界条件を検証する',
        '文書の参照先を更新する',
    ];
    const task = (id: string, title: string, status: string) => ({
        id,
        title,
        status,
        statusNote:
            '担当者が一覧の本文・資料・直近の事実を照合中です。更新後も開いていた項目が保持されることを確認します。',
        statusNoteAt: now - 60_000,
        tickets: ['DEVMIN-341'],
        branches: [`feature/preview-${id}`],
        prs: [341],
        sessions: [{ cli: 'codex', id: `preview-${id}`, role: '実装' }],
        related: ['T1', 'T2'],
        notes: [`確認記録/${id}.md`, '監督/進行中タスク.md'],
        createdAt: now - 86_400_000,
        updatedAt: now - 30_000,
    });
    const tasks = titles.map((title, index) =>
        task(`T${index + 1}`, title, statuses[index % statuses.length]),
    );
    const baseAction = { done: false, createdAt: now - 120_000, needsOk: true };
    const command = [
        'node ./tools/verify-preview.ts --workspace "/workspace/日本語の作業ディレクトリ" --task T1 --output ./tmp/確認結果.json',
        '# 画面を確認し、一覧の行と台帳に差異がないか照合する',
        'node ./tools/inspect-preview.ts --fields "状態,担当,ブランチ,関連PR,依頼全文,結果確認,次回確認予定" --include-history --format json',
    ].join('\n');
    const actions = [
        {
            ...baseAction,
            id: 'U1',
            taskId: 'T1',
            priority: 1,
            kind: 'execution',
            summary: '一覧画面を確認し、結果を記録する',
            text: '明るいテーマと暗いテーマで本文・コマンド・リンクを確認してください。\n狭いサイドバーでも横スクロールせず全文を読めることを確認し、結果が揃ってから完了を選びます。',
            command,
            doc: '.agents/ローカルタスク/監督/進行中タスク.md',
        },
        {
            ...baseAction,
            id: 'U2',
            taskId: 'T2',
            priority: 2,
            kind: 'execution',
            summary: '検証結果のファイルを確認する',
            text: '結果の内容と前回との差異を確認してください。操作の選択はこのプレビュー内だけに残り、台帳へは保存されません。',
            command: 'node ./tools/check-preview.ts --task T2',
            doc: 'https://example.com/preview/reference',
        },
        {
            ...baseAction,
            id: 'U3',
            taskId: 'T3',
            priority: 1,
            kind: 'decision',
            summary: '更新後の見え方の方針を判断する',
            text: '推奨は、一覧の並び順を維持し、変更のある行だけを更新する方針です。\n判断資料と既存利用者への影響を読んで回答してください。',
            doc: '.agents/ローカルタスク/判断資料/一覧の更新方針.md',
        },
        {
            ...baseAction,
            id: 'U4',
            taskId: 'T4',
            priority: 2,
            kind: 'decision',
            summary: '通知の表示内容を確認する',
            text: '監督への通知は原文を読める形で出し、出典を明示する方針を推奨します。',
            doc: 'https://example.com/preview/decision',
        },
        {
            ...baseAction,
            id: 'U5',
            taskId: 'T5',
            priority: 3,
            kind: 'execution',
            summary: '確認結果が揃ったら再開する',
            text: '前提の確認が終わるまで保留します。',
            command,
            holdReason:
                '連携先の回答待ち。回答が届いたら前提を照合して再開する。',
        },
        {
            ...baseAction,
            id: 'U6',
            taskId: 'T6',
            priority: 3,
            kind: 'execution',
            summary: '前の依頼の完了後に実施する',
            text: 'U5の結果を確認した後に実施します。',
            command,
            after: ['U5'],
        },
        {
            ...baseAction,
            id: 'U7',
            taskId: 'T7',
            priority: 1,
            kind: 'execution',
            summary: '実行済みの結果を確認する',
            text: '検証処理を開始済みです。終了結果を見て、必要な証跡が揃ったら完了にしてください。',
            command,
            ranAt: now - 30_000,
        },
    ];
    const sessions = Object.fromEntries(
        tasks.map((value) => [
            `codex:preview-${value.id}`,
            {
                cli: 'codex',
                id: `preview-${value.id}`,
                state: '作業中',
                title: `${value.id} ${value.title}`,
                model: 'gpt-6.2',
                cwd: `.codex/worktrees/preview-${value.id}`,
                branch: `feature/preview-${value.id}`,
                firstPrompt: '一覧の全情報を確認できるようにしてください。',
                lastPrompt: '差分更新でも入力・開閉状態を保ってください。',
                lastReport:
                    '一覧表示と行操作の実装を確認しました。\n残る確認は明暗テーマと狭幅での実ブラウザ検証です。',
                updatedAt: now - 20_000,
            },
        ]),
    );
    const snapshot = projectBoard({
        registry: {
            version: 1,
            supervisor: { cli: 'codex', id: 'preview-T1' },
            tasks: [
                ...tasks,
                task('T13', '確認先の回答が届いたら再開する', '保留'),
                {
                    ...task('T14', '結果の確認を完了したタスク', '完了'),
                    completedAt: now - 10_000,
                },
            ],
            actions,
        },
        archive: {
            tasks: [
                {
                    ...task('T15', '完了して保管した確認作業', '完了'),
                    archivedAt: now - 86_400_000,
                },
            ],
        },
        state: {
            facts: {
                at: now,
                sessions,
                warnings: [],
                branches: Object.fromEntries(
                    tasks.map((value) => [
                        `feature/preview-${value.id}`,
                        {
                            name: `feature/preview-${value.id}`,
                            head: 'a'.repeat(40),
                            subject: '一覧と操作の確認内容を追加',
                            committedAt: now - 60_000,
                            pushed: true,
                            ahead: 0,
                            mergedDevelop: false,
                        },
                    ]),
                ),
                prs: {
                    341: {
                        number: 341,
                        title: '監督一覧に全項目と行操作を表示する',
                        state: 'OPEN',
                        isDraft: false,
                        url: 'https://example.com/preview/pull/341',
                        headRef: 'feature/preview-T1',
                        headOid: 'b'.repeat(40),
                        labels: ['マージレビュー：確認待ち'],
                        commentCount: 3,
                        reviewCount: 1,
                        checks: 'SUCCESS',
                        mergeable: 'MERGEABLE',
                        lastComment: {
                            at: now - 20_000,
                            author: '確認担当',
                            text: '画面と台帳の内容を照合しています。\nコマンドの折返しと詳細の開閉を確認してください。',
                        },
                    },
                },
                jira: {
                    'DEVMIN-341': {
                        key: 'DEVMIN-341',
                        summary: '監督の一覧を読みやすくする',
                        status: '作業中',
                        commentCount: 2,
                        url: 'https://example.com/preview/browse/DEVMIN-341',
                        lastComment: {
                            at: now - 40_000,
                            author: '責任者',
                            text: '一覧にある情報をすべて読めることを優先してください。',
                        },
                    },
                },
                worktrees: tasks.map((value) => ({
                    rel: `.codex/worktrees/preview-${value.id}`,
                    branch: `feature/preview-${value.id}`,
                    head: 'c'.repeat(40),
                })),
            },
            userMentions: {
                byUser: {
                    'github:preview-user': {
                        items: {
                            first: {
                                at: now - 60_000,
                                where: 'PR #341',
                                reason: 'レビューの確認依頼',
                                author: '確認担当',
                                kind: 'コメント',
                                agent: false,
                                snippet:
                                    '一覧の操作ボタンと長い本文を確認してください。\n原文の改行や <script>文字列</script> は文字として表示されます。',
                                url: 'https://example.com/preview/pull/341#comment-1',
                            },
                        },
                    },
                },
            },
        },
        events: Array.from({ length: 24 }, (_, index) => ({
            at: now - (24 - index) * 60_000,
            taskId: `T${(index % 12) + 1}`,
            kind: index % 3 === 0 ? 'status' : 'note',
            text: `確認記録 ${index + 1}: 一覧と台帳を照合しました。次の確認と担当を記録しています。`,
            by: '確認担当',
        })),
        source: 'legacy',
        updatedAt: now,
    });
    snapshot.workspace = 'サンプル台帳（操作は記録しません）';
    return snapshot;
}

export async function readPreviewSnapshot(
    workspaceRoot: string,
): Promise<BoardSnapshot> {
    const root = resolve(workspaceRoot);
    const directory = join(root, '.agents/ローカルタスク/監督');
    const warnings: string[] = [];
    const files = [
        'registry.json',
        'archive.json',
        'state.json',
        'events.jsonl',
    ];
    const read = await Promise.all(
        files.map(async (name) => {
            const path = join(directory, name);
            const [text, info] = await Promise.all([
                readFile(path, 'utf8'),
                stat(path),
            ]);
            return { text, modifiedAt: info.mtimeMs };
        }),
    );
    const events: unknown[] = [];
    const lines = read[3].text.split('\n');
    for (let index = 0; index < lines.length; index++) {
        if (!lines[index].trim()) continue;
        try {
            events.push(JSON.parse(lines[index]));
        } catch {
            if (index === lines.length - 1 && !read[3].text.endsWith('\n')) {
                warnings.push(
                    '出来事ログの末尾が書込み途中のため、完了した行まで表示しています',
                );
                break;
            }
            throw new Error(`出来事ログの${index + 1}行目を読み取れません`);
        }
    }
    const snapshot = projectBoard({
        registry: JSON.parse(read[0].text),
        archive: JSON.parse(read[1].text),
        state: JSON.parse(read[2].text),
        events,
        updatedAt: Math.max(...read.map((value) => value.modifiedAt)),
        source: 'legacy',
        readWarnings: warnings,
    });
    snapshot.workspace = root;
    return snapshot;
}

export function previewHtml(snapshot: BoardSnapshot, nonce: string): string {
    const data = JSON.stringify(snapshot).replace(
        /[<>&\u2028\u2029]/g,
        (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`,
    );
    const initial = `<script nonce="${nonce}">window.__initialBoard=${data};</script>`;
    return boardHtml("'self'", nonce, '/preview.js').replace(
        '</head>',
        `${initial}</head>`,
    );
}

export async function startPreview(workspaceRoot?: string, port = 8873) {
    if (!Number.isInteger(port) || port < 0 || port > 65535)
        throw new Error(
            'プレビューのポートは0から65535の整数を指定してください',
        );
    const snapshot = workspaceRoot
        ? await readPreviewSnapshot(workspaceRoot)
        : sampleSnapshot();
    const built = await build({
        entryPoints: [
            join(dirname(fileURLToPath(import.meta.url)), 'previewEntry.ts'),
        ],
        bundle: true,
        write: false,
        platform: 'browser',
        target: 'es2022',
        format: 'iife',
    });
    const script = built.outputFiles[0].contents;
    const html = previewHtml(snapshot, randomBytes(24).toString('base64url'));
    const server = createServer((request, response) => {
        response.setHeader('Cache-Control', 'no-store');
        response.setHeader('X-Content-Type-Options', 'nosniff');
        if (request.method !== 'GET' && request.method !== 'HEAD') {
            response.writeHead(405, { Allow: 'GET, HEAD' });
            response.end();
            return;
        }
        const asset =
            request.url === '/'
                ? { type: 'text/html; charset=utf-8', body: html }
                : request.url === '/preview.js'
                  ? { type: 'text/javascript; charset=utf-8', body: script }
                  : undefined;
        if (!asset) {
            response.writeHead(404);
            response.end();
            return;
        }
        response.writeHead(200, { 'Content-Type': asset.type });
        response.end(request.method === 'HEAD' ? undefined : asset.body);
    });
    await new Promise<void>((accept, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => {
            server.off('error', reject);
            accept();
        });
    });
    const address = server.address();
    if (!address || typeof address === 'string')
        throw new Error('プレビューの待受先を確認できません');
    console.log(`プレビューを開始しました: http://127.0.0.1:${address.port}/`);
    console.log(
        workspaceRoot
            ? '台帳4原稿を読取り表示しています。操作は記録しません。'
            : 'サンプル台帳を表示しています。操作は記録しません。',
    );
    return server;
}

if (
    process.argv[1] &&
    resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
    const args = process.argv.slice(2);
    const portArg = args.find((arg) => arg.startsWith('--port='));
    const roots = args.filter((arg) => !arg.startsWith('--port='));
    if (roots.length > 1) {
        console.error(
            '使用方法: node test/preview.ts [workspace-root] [--port=8873]',
        );
        process.exitCode = 1;
    } else {
        startPreview(
            roots[0],
            portArg ? Number(portArg.slice('--port='.length)) : 8873,
        ).catch((error: unknown) => {
            console.error(
                'プレビューを開始できませんでした:',
                error instanceof Error ? error.message : String(error),
            );
            process.exitCode = 1;
        });
    }
}
