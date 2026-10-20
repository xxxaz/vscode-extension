export const state = {
    source: '- [ ] task\n',
    disk: '- [ ] task\n',
    dirty: false,
    version: 1,
    applied: 0,
    saves: 0,
    shown: 0,
    applyResult: true,
    saveResult: true,
    onRead: undefined as (() => void) | undefined,
    onApply: undefined as (() => void) | undefined,
    saveError: false,
};
export const uri = { scheme: 'file', toString: () => 'file:///test.md' };
export const document = {
    get isDirty() {
        return state.dirty;
    },
    get version() {
        return state.version;
    },
    getText: () => state.source,
    positionAt: (offset: number) => offset,
    async save() {
        state.saves++;
        if (state.saveError) throw new Error('disk write failed');
        if (state.saveResult) {
            state.disk = state.source;
            state.dirty = false;
        }
        return state.saveResult;
    },
};
export class Range {
    constructor(
        public start: number,
        public end: number
    ) {}
}
export class WorkspaceEdit {
    range!: Range;
    text!: string;
    replace(_uri: unknown, range: Range, text: string) {
        this.range = range;
        this.text = text;
    }
}
export const workspace = {
    openTextDocument: async () => document,
    fs: {
        readFile: async () => {
            state.onRead?.();
            return Buffer.from(state.disk);
        },
    },
    applyEdit: async (edit: WorkspaceEdit) => {
        state.applied++;
        if (!state.applyResult) return false;
        state.source =
            state.source.slice(0, edit.range.start) +
            edit.text +
            state.source.slice(edit.range.end);
        state.version++;
        state.dirty = true;
        state.onApply?.();
        return true;
    },
};
export const window = {
    showTextDocument: async () => {
        state.shown++;
    },
};
export const ViewColumn = { Beside: -2 };
