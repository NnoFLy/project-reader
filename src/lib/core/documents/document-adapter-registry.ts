import type { DocumentAdapter } from "$lib/document-model"

export interface Disposable {
    dispose(): void
}

export class DocumentAdapterRegistry {
    private readonly adapters = new Map<string, DocumentAdapter>()

    private readonly lifetimes = new WeakMap<DocumentAdapter, AbortController>()

    signalFor(adapter: DocumentAdapter): AbortSignal {
        const lifetime = this.lifetimes.get(adapter)
        if (!lifetime) throw new Error("Document adapter is not registered")
        return lifetime.signal
    }

    register(adapter: DocumentAdapter): Disposable {
        if (!adapter.id.trim()) throw new Error("Document adapter ID is required")
        if (this.adapters.has(adapter.id)) {
            throw new Error(`Document adapter is already registered: ${adapter.id}`)
        }
        this.adapters.set(adapter.id, adapter)
        this.lifetimes.set(adapter, new AbortController())
        let disposed = false
        return {
            dispose: () => {
                if (disposed) return
                disposed = true
                if (this.adapters.get(adapter.id) === adapter) this.unregister(adapter.id)
            },
        }
    }

    unregister(id: string): boolean {
        const adapter = this.adapters.get(id)
        if (!adapter) return false
        this.adapters.delete(id)
        this.lifetimes.get(adapter)?.abort()
        return true
    }

    get(id: string): DocumentAdapter | undefined {
        return this.adapters.get(id)
    }

    list(): readonly DocumentAdapter[] {
        return [...this.adapters.values()]
    }

    clear(): void {
        for (const id of this.adapters.keys()) this.unregister(id)
    }
}
