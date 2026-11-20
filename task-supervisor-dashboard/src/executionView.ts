import type { ExecutionPreview } from './executionRunner.ts';

// 受付型ではなく、正本のreadをadapterで変換した画面用の値。
export interface ResultAccessView<Context> {
    context: Context;
    canChangeDisclosure: boolean;
    userDisplay: string;
    databaseStorage: string;
    aiDisclosure: 'unknown' | 'allowed' | 'denied';
    resultConfirmation: string;
}
export interface ResultAccessAdapter<Context> {
    read(): Promise<ResultAccessView<Context>>;
    changeDisclosure(context: Context, allowed: boolean): Promise<void>;
}

export function mountExecutionPreview(
    host: HTMLElement,
    preview: Readonly<ExecutionPreview>,
    confirm: () => void,
    cancel: () => void,
) {
    const doc = host.ownerDocument;
    const root = doc.createElement('section');
    root.className = 'execution-preview';
    const heading = doc.createElement('h3');
    heading.textContent = preview.requestLabel;
    const place = doc.createElement('p');
    place.textContent = `実行場所: ${preview.workingDirectory}`;
    const command = doc.createElement('pre');
    command.className = 'field-value';
    command.textContent = preview.command;
    root.append(heading, place, command);
    for (const material of preview.documents) {
        const title = doc.createElement('h4');
        title.textContent = material.label;
        const body = doc.createElement('pre');
        body.className = 'field-value';
        body.textContent = material.body;
        root.append(title, body);
    }
    const checkLabel = doc.createElement('label'),
        check = doc.createElement('input');
    check.type = 'checkbox';
    checkLabel.append(
        check,
        doc.createTextNode('上記の固定版の資料とコマンド全文を確認しました'),
    );
    const reason = doc.createElement('p');
    reason.setAttribute('role', 'status');
    const send = doc.createElement('button');
    send.type = 'button';
    send.textContent = '実行を確認';
    send.disabled = true;
    const close = doc.createElement('button');
    close.type = 'button';
    close.textContent = 'キャンセル';
    root.append(checkLabel, reason, send, close);
    host.append(root);
    let allowed = false,
        settled = false,
        disposed = false;
    const update = () => {
        send.disabled = !allowed || !check.checked || settled;
    };
    const onCheck = () => update();
    const onConfirm = () => {
        if (disposed || send.disabled) return;
        settled = true;
        update();
        confirm();
    };
    const onCancel = () => {
        if (disposed || settled) return;
        settled = true;
        update();
        cancel();
    };
    check.addEventListener('change', onCheck);
    send.addEventListener('click', onConfirm);
    close.addEventListener('click', onCancel);
    reason.textContent = '正式な実行受付は未接続です';
    return {
        availability(value: { allowed: boolean; reason: string }) {
            if (disposed) return;
            allowed = value.allowed;
            reason.textContent = value.reason;
            if (!allowed) check.checked = false;
            update();
        },
        dispose() {
            disposed = true;
            check.removeEventListener('change', onCheck);
            send.removeEventListener('click', onConfirm);
            close.removeEventListener('click', onCancel);
            root.remove();
        },
    };
}

export function mountResultAccess<Context>(
    host: HTMLElement,
    adapter: ResultAccessAdapter<Context>,
) {
    const doc = host.ownerDocument,
        root = doc.createElement('section');
    root.className = 'execution-access';
    const status = doc.createElement('p');
    status.setAttribute('role', 'status');
    const facts = doc.createElement('p');
    facts.className = 'field-value';
    const change = doc.createElement('button');
    change.type = 'button';
    change.textContent = 'AIへの結果閲覧を変更';
    change.disabled = true;
    const refresh = doc.createElement('button');
    refresh.type = 'button';
    refresh.textContent = '設定を再取得';
    root.append(status, facts, change, refresh);
    host.append(root);
    let current: ResultAccessView<Context> | undefined,
        busy = false,
        disposed = false;
    const controls = () => {
        change.disabled =
            busy ||
            !current?.canChangeDisclosure ||
            current.aiDisclosure === 'unknown';
        refresh.disabled = busy;
    };
    const show = (view: ResultAccessView<Context>) => {
        current = view;
        facts.textContent = `本人への表示: ${view.userDisplay}\nDBへの保存: ${view.databaseStorage}\n担当AIへの開示: ${view.aiDisclosure === 'unknown' ? '未設定' : view.aiDisclosure === 'allowed' ? '許可' : '非許可'}\n結果確認（needsOk）: ${view.resultConfirmation}`;
        change.textContent =
            view.aiDisclosure === 'allowed'
                ? 'AIへの結果閲覧を取り消す'
                : 'AIへの結果閲覧を許可';
    };
    const load = async () => {
        if (busy || disposed) return;
        busy = true;
        controls();
        try {
            const view = await adapter.read();
            if (!disposed) {
                show(view);
                status.textContent = '保存された設定を表示しています';
            }
        } catch {
            if (!disposed) {
                current = undefined;
                status.textContent =
                    '設定を取得できません。前回の表示は最新として扱えません';
            }
        }
        if (!disposed) {
            busy = false;
            controls();
        }
    };
    const apply = async () => {
        if (disposed || change.disabled || !current) return;
        const selected = current,
            desired = selected.aiDisclosure !== 'allowed';
        busy = true;
        controls();
        status.textContent = '設定の保存結果を確認しています';
        try {
            await adapter.changeDisclosure(selected.context, desired);
            const saved = await adapter.read();
            if (disposed) return;
            if (saved.aiDisclosure !== (desired ? 'allowed' : 'denied'))
                throw Error('設定が一致しません');
            show(saved);
            status.textContent = '設定の保存と読戻しを確認しました';
        } catch {
            if (!disposed) {
                current = undefined;
                status.textContent =
                    '変更の保存結果が不明です。再取得して確認してください';
            }
        }
        if (!disposed) {
            busy = false;
            controls();
        }
    };
    const onRefresh = () => {
            void load();
        },
        onChange = () => {
            void apply();
        };
    refresh.addEventListener('click', onRefresh);
    change.addEventListener('click', onChange);
    status.textContent = '設定はまだ取得していません';
    return {
        load,
        dispose() {
            disposed = true;
            refresh.removeEventListener('click', onRefresh);
            change.removeEventListener('click', onChange);
            root.remove();
        },
    };
}
