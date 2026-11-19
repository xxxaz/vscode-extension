import { randomUUID } from 'node:crypto';
import {
    type Action,
    candidates,
    commonView,
    type Operation,
    type PendingAnswer,
    revision,
} from './boardClient.ts';
import { type ActionGateway, OperationPending } from './gateway.ts';

export interface Interaction {
    pick(actions: Action[], operation: Operation): Promise<Action | undefined>;
    choice(): Promise<'recommended' | 'custom' | undefined>;
    recover(): Promise<'retry' | 'edit' | undefined>;
    input(title: string, value?: string): Promise<string | undefined>;
    answerInput(initial?: string): Promise<string | undefined>;
    confirm(message: string, detail: string): Promise<boolean>;
    info(message: string, state?: 'info' | 'pending' | 'success'): void;
    error(message: string): void;
}
export interface Drafts {
    get(key: string): PendingAnswer | undefined;
    set(key: string, value: PendingAnswer | undefined): Promise<void>;
}

export async function record(
    requestedOperation: Operation,
    ledger: ActionGateway,
    ui: Interaction,
    drafts: Drafts,
    selected?: { id: string; revision: string },
): Promise<void> {
    let operation = requestedOperation;
    let forceRecommended = false;
    let pending: PendingAnswer | undefined;
    let previous: PendingAnswer | undefined;
    const key = `taskSupervisor.answer:${ledger.root}`;
    try {
        const resumed = await ledger.resume?.();
        if (resumed) {
            if (drafts.get(key)?.commandId === resumed.commandId)
                await drafts.set(key, undefined);
            ui.info(resumed.message, 'success');
            return;
        }
        const initial = await ledger.read();
        let selectedRow = selected
            ? candidates(initial, operation).find((a) => a.id === selected.id)
            : undefined;
        if (
            selected &&
            (!selectedRow || revision(selectedRow) !== selected.revision)
        )
            throw new Error(
                '一覧の依頼が更新されました。最新の行を確認して操作してください',
            );
        if (operation === 'complete') {
            const rows = candidates(initial, operation);
            if (!rows.length) {
                ui.info('この操作の対象となる未完了の依頼はありません');
                return;
            }
            selectedRow ??= await ui.pick(rows, operation);
            if (!selectedRow) return;
            if (
                commonView(initial).rows.find(
                    (row) => row.id === selectedRow?.id,
                )?.kind === 'decision'
            ) {
                operation = 'answer';
                forceRecommended = true;
            }
        }
        if (operation === 'answer') pending = drafts.get(key);
        if (pending) {
            if (selectedRow && pending.id !== selectedRow.id)
                throw new Error(
                    `${pending.id} の未保存回答を保持しています。先にその依頼の回答を確認してください`,
                );
            if (await ledger.hasAnswer(pending)) {
                await drafts.set(key, undefined);
                ui.info(`${pending.id} の回答は台帳へ保存済みです`, 'success');
                return;
            }
            const recovery = await ui.recover();
            if (!recovery) return;
            if (recovery === 'retry') {
                if (
                    !(await ui.confirm(
                        `${pending.id} の未保存回答を同じ操作IDで再送しますか？`,
                        pending.answer,
                    ))
                )
                    return;
                await ledger.answer(pending);
                await drafts.set(key, undefined);
                ui.info(`${pending.id} の回答と完了を記録しました`, 'success');
                return;
            }
            previous = pending;
            pending = undefined;
        }
        const rows = candidates(await ledger.read(), operation);
        if (!rows.length) {
            ui.info(
                operation === 'ran'
                    ? 'キック済みを記録できる未完了の実行依頼はありません'
                    : 'この操作の対象となる未完了の依頼はありません',
            );
            return;
        }
        const row = selectedRow ?? (await ui.pick(rows, operation));
        if (!row) return;
        if (operation !== 'answer') {
            if (
                !(await ui.confirm(
                    `${row.id} を${operation === 'complete' ? (row.needsOk ? '結果確認 OK' : '完了') : 'キック済み'}として記録しますか？`,
                    `${row.text}${row.command ? `\n\nコマンド（この操作では実行しません）:\n${row.command}` : ''}`,
                ))
            )
                return;
            await ledger.complete(row, operation);
            ui.info(
                `${row.id} の${operation === 'complete' ? '完了' : 'キック済み'}を台帳へ記録しました`,
                'success',
            );
            return;
        }
        let documentVersion: string | undefined;
        if (/^https?:\/\//i.test(row.doc ?? '')) {
            documentVersion = await ui.input(
                `資料 ${row.doc} を確認した版（改訂番号など）`,
            );
            if (documentVersion === undefined) return;
            if (!documentVersion.trim())
                throw new Error('URL資料を確認した版を入力してください');
        }
        const context = await ledger.answerContext(row, documentVersion);
        if (
            !(await ui.confirm(
                `${row.id} の依頼と資料を確認してください`,
                `${context.request.text}\n\n資料: ${context.document?.ref ?? 'なし'}\n資料の版: ${context.document?.version ?? 'なし'}`,
            ))
        )
            return;
        const mode = forceRecommended ? 'recommended' : await ui.choice();
        if (!mode) return;
        const answer =
            mode === 'recommended'
                ? '推奨で進める'
                : await ui.answerInput(previous?.answer);
        if (answer === undefined) return;
        if (!answer.trim())
            throw new Error('空白以外を含む回答を入力してください');
        if (new TextEncoder().encode(answer).length > 128 * 1024)
            throw new Error('回答は128 KiB以内で入力してください');
        const respondent = await ui.input(
            '回答者の識別名（例: 氏名・社内アカウント名）',
            previous?.respondent,
        );
        if (respondent === undefined) return;
        if (!respondent.trim() || respondent.length > 500)
            throw new Error('回答者を500文字以内で入力してください');
        if (
            !(await ui.confirm(
                `${row.id} の回答を保存して完了にしますか？${row.needsOk ? ' 結果確認 OK も記録します。' : ''}`,
                `回答者: ${respondent}\n\n回答（原文）:\n${answer}`,
            ))
        )
            return;
        pending = {
            id: row.id,
            answer,
            respondent,
            requestVersion: context.requestVersion,
            commandId: randomUUID(),
            documentVersion,
            confirmedResult: !!row.needsOk,
            ...(context.runtime ? { runtime: context.runtime } : {}),
        };
        await drafts.set(key, pending);
        await ledger.answer(pending);
        await drafts.set(key, undefined);
        ui.info(`${row.id} の回答原文と完了を台帳へ記録しました`, 'success');
    } catch (error) {
        if (error instanceof OperationPending) {
            ui.info(error.message, 'pending');
            return;
        }
        ui.error(
            `記録できませんでした: ${String(error)}${pending ? '\n回答と同じ操作IDを保持しました。回答コマンドで台帳を確認してから再送できます。' : ''}`,
        );
    }
}
