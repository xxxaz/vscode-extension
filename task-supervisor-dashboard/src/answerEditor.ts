export interface AnswerDocument {
    getText(): string;
}
export interface AnswerEditor<Document extends AnswerDocument> {
    open(content: string): Promise<Document>;
    show(document: Document): Promise<void>;
    confirm(): Promise<boolean>;
}
export async function captureAnswer<Document extends AnswerDocument>(
    editor: AnswerEditor<Document>,
    initial = '',
): Promise<string | undefined> {
    const document = await editor.open(initial);
    await editor.show(document);
    if (!(await editor.confirm())) return undefined;
    return document.getText();
}
