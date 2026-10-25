/** Bounded work queue; cancellation removes waiting work before it can send a request. */
export class WorkQueue {
    private running = 0;
    private waiting: Array<() => void> = [];
    constructor(private readonly limit: number) {}
    async run<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
        signal.throwIfAborted();
        if(this.running >= this.limit) {
            await new Promise<void>((resolve, reject) => {
                const ready = () => { signal.removeEventListener("abort", abort); resolve(); };
                const abort = () => { this.waiting = this.waiting.filter((item) => item !== ready); reject(signal.reason); };
                this.waiting.push(ready);
                signal.addEventListener("abort", abort, { once: true });
            });
        } else this.running++;
        try { signal.throwIfAborted(); return await work(); }
        finally {
            const next = this.waiting.shift();
            if(next) next();
            else this.running--;
        }
    }
}
