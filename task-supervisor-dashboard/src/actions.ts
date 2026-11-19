import { randomUUID } from 'node:crypto';
import {
    candidates,
    Ledger,
    type Action,
    type Operation,
    type PendingAnswer,
} from './boardClient.ts';

export interface Interaction {
    pick(actions: Action[], operation: Operation): Promise<Action | undefined>;
    choice(): Promise<'recommended' | 'custom' | undefined>;
    recover(): Promise<'retry' | 'edit' | undefined>;
    input(title: string, value?: string): Promise<string | undefined>;
    confirm(message: string, detail: string): Promise<boolean>;
    info(message: string): void;
    error(message: string): void;
}
export interface Drafts {
    get(key: string): PendingAnswer | undefined;
    set(key: string, value: PendingAnswer | undefined): Promise<void>;
}

export async function record(
    operation: Operation,
    ledger: Ledger,
    ui: Interaction,
    drafts: Drafts
): Promise<void> {
    let pending: PendingAnswer | undefined;
    let previous: PendingAnswer | undefined;
    const key = `taskSupervisor.answer:${ledger.root}`;
    try {
        if (operation === 'answer' && (pending = drafts.get(key))) {
            if (await ledger.hasAnswer(pending)) {
                await drafts.set(key, undefined);
                ui.info(`${pending.id} の回答は台帳へ保存済みです`);
                return;
            }
            const recovery = await ui.recover();
            if (!recovery) return;
            if (recovery === 'retry') {
                if (
                    !(await ui.confirm(
                        `${pending.id} の未保存回答を同じ操作IDで再送しますか？`,
                        pending.answer
                    ))
                )
                    return;
                await ledger.answer(pending);
                await drafts.set(key, undefined);
                ui.info(`${pending.id} の回答と完了を記録しました`);
                return;
            }
            previous = pending;
            pending = undefined;
        }
        const rows = candidates(await ledger.read(), operation);
        if (!rows.length) {
            ui.info(
                operation === 'ran'
                    ? 'キック済みを記録できる依頼はありません。現行CLIは結果確認が必要な実行依頼だけに対応します'
                    : 'この操作の対象となる未完了の依頼はありません'
            );
            return;
        }
        const row = await ui.pick(rows, operation);
        if (!row) return;
        if (operation !== 'answer') {
            if (
                !(await ui.confirm(
                    `${row.id} を${operation === 'complete' ? '完了（結果確認 OK）' : 'キック済み'}として記録しますか？`,
                    `${row.text}${row.command ? '\n\nコマンド（この操作では実行しません）:\n' + row.command : ''}`
                ))
            )
                return;
            await ledger.complete(row, operation);
            ui.info(
                `${row.id} の${operation === 'complete' ? '完了' : 'キック済み'}を台帳へ記録しました`
            );
            return;
        }
        let documentVersion: string | undefined;
        if (/^https?:\/\//i.test(row.doc ?? '')) {
            documentVersion = await ui.input(
                `資料 ${row.doc} を確認した版（改訂番号など）`
            );
            if (documentVersion === undefined) return;
            if (!documentVersion.trim())
                throw new Error('URL資料を確認した版を入力してください');
        }
        const context = await ledger.answerContext(row, documentVersion);
        if (
            !(await ui.confirm(
                `${row.id} の依頼と資料を確認してください`,
                `${context.request.text}\n\n資料: ${context.document?.ref ?? 'なし'}\n資料の版: ${context.document?.version ?? 'なし'}`
            ))
        )
            return;
        const mode = await ui.choice();
        if (!mode) return;
        const answer =
            mode === 'recommended'
                ? '推奨で進める'
                : await ui.input(`${row.id} の回答原文`, previous?.answer);
        if (answer === undefined) return;
        if (!answer.trim())
            throw new Error('空白以外を含む回答を入力してください');
        if (new TextEncoder().encode(answer).length > 128 * 1024)
            throw new Error('回答は128 KiB以内で入力してください');
        const respondent = await ui.input(
            '回答者の識別名（例: 氏名・社内アカウント名）',
            previous?.respondent
        );
        if (respondent === undefined) return;
        if (!respondent.trim() || respondent.length > 500)
            throw new Error('回答者を500文字以内で入力してください');
        if (
            !(await ui.confirm(
                `${row.id} の回答を保存して完了にしますか？${row.needsOk ? ' 結果確認 OK も記録します。' : ''}`,
                `回答者: ${respondent}\n\n回答（原文）:\n${answer}`
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
        };
        await drafts.set(key, pending);
        await ledger.answer(pending);
        await drafts.set(key, undefined);
        ui.info(`${row.id} の回答原文と完了を台帳へ記録しました`);
    } catch (error) {
        ui.error(
            `記録できませんでした: ${String(error)}${pending ? '\n回答と同じ操作IDを保持しました。回答コマンドで台帳を確認してから再送できます。' : ''}`
        );
    }
}
