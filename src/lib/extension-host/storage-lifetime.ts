import type { StorageBackend } from "../core/storage"

/** Fences logical work; already issued physical work must drain before replacement. */
export class ExtensionStorageLifetime implements StorageBackend {
    private readonly pending = new Set<Promise<unknown>>()

    constructor(
        private readonly backend: StorageBackend,
        private readonly signal: AbortSignal,
    ) {}

    get(key: string): Promise<unknown> {
        return this.run(() => this.backend.get(key))
    }

    set(key: string, value: unknown): Promise<void> {
        return this.run(() => this.backend.set(key, value))
    }

    delete(key: string): Promise<void> {
        return this.run(() => this.backend.delete(key))
    }

    keys(prefix?: string): Promise<readonly string[]> {
        return this.run(() => this.backend.keys(prefix))
    }

    async whenQuiescent(): Promise<void> {
        await Promise.allSettled(this.pending)
        // Native backends can reject a logical operation before its transaction is terminal.
        const backend = this.backend as StorageBackend & { whenQuiescent?(): Promise<void> }
        await backend.whenQuiescent?.()
    }

    private async run<T>(operation: () => Promise<T>): Promise<T> {
        this.signal.throwIfAborted()
        const physical = Promise.resolve().then(() => {
            this.signal.throwIfAborted()
            return operation()
        })
        this.pending.add(physical)
        try {
            const value = await physical
            this.signal.throwIfAborted()
            return value
        } finally {
            this.pending.delete(physical)
        }
    }
}
