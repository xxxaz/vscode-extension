import * as vscode from 'vscode';
import { checkboxEdit, type CheckboxSnapshot } from './checkboxes.js';

const editing = new Set<string>();

/** 既存の未保存編集を保存せず、表示した内容の一文字だけを通常の Undo 履歴に加える。 */
export async function saveCheckbox(
    uri: vscode.Uri,
    snapshot: CheckboxSnapshot | undefined,
    key: unknown,
    checked: unknown
): Promise<void> {
    if (uri.scheme !== 'file' || !snapshot)
        throw new Error('この表示は読み取り専用です');
    const edit = checkboxEdit(snapshot, key, checked);
    if (!edit)
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
        const version = document.version;
        const disk = new TextDecoder('utf-8').decode(
            await vscode.workspace.fs.readFile(uri)
        );
        if (
            disk !== snapshot.source ||
            document.getText() !== snapshot.source ||
            document.version !== version ||
            document.isDirty
        ) {
            throw new Error(
                'ファイルが変更されています。描き直してから操作してください'
            );
        }
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
            snapshot.source.slice(0, edit.offset) +
            edit.text +
            snapshot.source.slice(edit.offset + 1);
        const diskBeforeSave = new TextDecoder('utf-8').decode(
            await vscode.workspace.fs.readFile(uri)
        );
        if (
            diskBeforeSave !== snapshot.source ||
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
