import type { DocumentAdapter } from "$lib/document-model"

export interface Disposable {
    dispose(): void
}

export class DocumentAdapterRegistry {
    private readonly adapters = new Map<string, DocumentAdapter>()

    register(adapter: DocumentAdapter): Disposable {
        if (!adapter.id.trim()) throw new Error("Document adapter ID is required")
        if (this.adapters.has(adapter.id)) {
            throw new Error(`Document adapter is already registered: ${adapter.id}`)
        }
        this.adapters.set(adapter.id, adapter)
        let disposed = false
        return {
            dispose: () => {
                if (disposed) return
                disposed = true
                if (this.adapters.get(adapter.id) === adapter) this.adapters.delete(adapter.id)
            },
        }
    }

    unregister(id: string): boolean {
        return this.adapters.delete(id)
    }

    get(id: string): DocumentAdapter | undefined {
        return this.adapters.get(id)
    }

    list(): readonly DocumentAdapter[] {
        return [...this.adapters.values()]
    }

    clear(): void {
        this.adapters.clear()
    }
}
