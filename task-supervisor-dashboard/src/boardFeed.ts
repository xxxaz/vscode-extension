import type { BoardSnapshot, BoardUpdate } from './dashboardTypes.ts';

type Listener = (message: BoardUpdate) => void;
const STALE = '一覧の読取りに失敗しました（前回の表示を保持）: ';

export class BoardFeed {
    private listeners = new Set<Listener>();
    private timer?: ReturnType<typeof setTimeout>;
    private running?: Promise<void>;
    private dirty = false;
    private disposed = false;
    private signature = '';
    private readonly read: () => Promise<BoardSnapshot>;
    private readonly delayMs: number;
    current?: BoardSnapshot;
    constructor(read: () => Promise<BoardSnapshot>, delayMs = 120) {
        this.read = read;
        this.delayMs = delayMs;
    }
    subscribe(listener: Listener): () => void {
        this.listeners.add(listener);
        this.replay(listener);
        return () => this.listeners.delete(listener);
    }
    replay(listener: Listener): void {
        if (this.current)
            listener({ type: 'snapshot', snapshot: this.current });
    }
    publish(message: BoardUpdate): void {
        if (!this.disposed)
            for (const listener of this.listeners) listener(message);
    }
    request(): void {
        if (this.disposed) return;
        if (this.running) {
            this.dirty = true;
            return;
        }
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => {
            this.timer = undefined;
            void this.refresh();
        }, this.delayMs);
    }
    refresh(): Promise<void> {
        if (this.disposed) return Promise.resolve();
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = undefined;
        }
        this.dirty = true;
        if (this.running) return this.running;
        this.running = this.load().finally(() => {
            this.running = undefined;
        });
        return this.running;
    }
    private snapshot(value: BoardSnapshot): void {
        if (this.disposed) return;
        const signature = JSON.stringify(value);
        if (signature === this.signature) return;
        this.current = value;
        this.signature = signature;
        this.publish({ type: 'snapshot', snapshot: value });
    }
    private async load(): Promise<void> {
        while (this.dirty && !this.disposed) {
            this.dirty = false;
            try {
                this.snapshot(await this.read());
            } catch (error) {
                const message = `${STALE}${String(error)}`;
                if (this.current)
                    this.snapshot({
                        ...this.current,
                        warnings: [
                            ...this.current.warnings.filter(
                                (w) => !w.startsWith(STALE),
                            ),
                            message,
                        ],
                    });
                else
                    this.publish({
                        type: 'status',
                        message,
                        failed: true,
                        state: 'error',
                    });
            }
        }
    }
    dispose(): void {
        this.disposed = true;
        if (this.timer) clearTimeout(this.timer);
        this.listeners.clear();
    }
}
