import * as vscode from 'vscode';
import { checkboxEdit, relocateCheckbox, type CheckboxSnapshot } from './checkboxes.js';

const editing = new Set<string>();
const SETTLE_ATTEMPTS = 5;
const SETTLE_MS = 100;

/** 既存の未保存編集を保存せず、表示した内容の一文字だけを通常の Undo 履歴に加える。 */
export async function saveCheckbox(
    uri: vscode.Uri,
    snapshot: CheckboxSnapshot | undefined,
    key: unknown,
    checked: unknown
): Promise<void> {
    if (uri.scheme !== 'file' || !snapshot)
        throw new Error('この表示は読み取り専用です');
    if (!checkboxEdit(snapshot, key, checked))
        throw new Error(
            '表示が更新されています。描き直してから操作してください'
        );
    const id = uri.toString();
    if (editing.has(id))
        throw new Error('保存中です。完了してから操作してください');
    editing.add(id);
    let applied = false;
    let document: vscode.TextDocument | undefined;
    try {
        document = await vscode.workspace.openTextDocument(uri);
        if (document.isDirty)
            throw new Error(
                '未保存の編集があります。テキストエディタで保存または取り消してから操作してください'
            );
        // ボードの定期更新など、描画後にファイルが書き換わっていても、同じ行を探し直して押された通りに保存する。
        // ディスクとバッファが揃うまで (watcher の反映待ち) は短く待ち直す
        let base = '';
        let version = 0;
        let edit: { offset: number; text: string } | undefined;
        for (let attempt = 0; ; attempt++) {
            version = document.version;
            const disk = new TextDecoder('utf-8').decode(
                await vscode.workspace.fs.readFile(uri)
            );
            base = document.getText();
            if (document.isDirty)
                throw new Error(
                    '未保存の編集があります。テキストエディタで保存または取り消してから操作してください'
                );
            if (disk === base && document.version === version) break;
            if (attempt >= SETTLE_ATTEMPTS)
                throw new Error(
                    'ファイルが変更されています。描き直してから操作してください'
                );
            await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
        }
        edit =
            base === snapshot.source
                ? checkboxEdit(snapshot, key, checked)
                : relocateCheckbox(snapshot, base, key as string, checked as boolean);
        if (!edit)
            throw new Error(
                'ファイルが変更されています。描き直してから操作してください'
            );
        const change = new vscode.WorkspaceEdit();
        change.replace(
            uri,
            new vscode.Range(
                document.positionAt(edit.offset),
                document.positionAt(edit.offset + 1)
            ),
            edit.text
        );
        if (!(await vscode.workspace.applyEdit(change)))
            throw new Error('チェックの変更を適用できませんでした');
        applied = true;
        const expected =
            base.slice(0, edit.offset) + edit.text + base.slice(edit.offset + 1);
        const diskBeforeSave = new TextDecoder('utf-8').decode(
            await vscode.workspace.fs.readFile(uri)
        );
        if (
            diskBeforeSave !== base ||
            document.getText() !== expected ||
            document.version !== version + 1
        ) {
            throw new Error(
                '編集中にファイルが変更されました。保存せずテキストエディタを開きます'
            );
        }
        if (!(await document.save()))
            throw new Error(
                '保存できませんでした。テキストエディタで変更を確認してください'
            );
    } catch (error) {
        if (applied && document) {
            await vscode.window.showTextDocument(document, {
                preview: false,
                viewColumn: vscode.ViewColumn.Beside,
            });
        }
        throw error;
    } finally {
        editing.delete(id);
    }
}
