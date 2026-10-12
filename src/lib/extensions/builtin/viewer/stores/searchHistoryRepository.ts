const STORAGE_KEY = "viewer.searchHistory.v1"
const LEGACY_STORAGE_KEY = "search_history"
const HISTORY_LIMIT = 10

type HistoryRecord = Record<string, string[]>

export interface SearchHistoryRepository {
    load(bookId: string): string[]
    save(bookId: string, queries: readonly string[]): void
    clear(bookId: string): void
}

export class LocalSearchHistoryRepository implements SearchHistoryRepository {
    constructor(
        private readonly storage: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null,
    ) {
        try {
            this.storage?.removeItem(LEGACY_STORAGE_KEY)
        } catch {
            // Storage may be unavailable in private or restricted browser contexts.
        }
    }

    load(bookId: string): string[] {
        const histories = this.readAll()
        const history = histories[bookId]
        if (!Array.isArray(history)) return []
        return normalizeHistory(history)
    }

    save(bookId: string, queries: readonly string[]): void {
        if (!this.storage) return
        const histories = this.readAll()
        histories[bookId] = normalizeHistory(queries)
        this.writeAll(histories)
    }

    clear(bookId: string): void {
        if (!this.storage) return
        const histories = this.readAll()
        delete histories[bookId]
        this.writeAll(histories)
    }

    private readAll(): HistoryRecord {
        if (!this.storage) return {}
        try {
            const raw = this.storage.getItem(STORAGE_KEY)
            if (!raw) return {}
            const parsed: unknown = JSON.parse(raw)
            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {}
            return parsed as HistoryRecord
        } catch {
            return {}
        }
    }

    private writeAll(histories: HistoryRecord): void {
        try {
            this.storage?.setItem(STORAGE_KEY, JSON.stringify(histories))
        } catch (error) {
            console.error("[SearchHistoryRepository] Failed to save search history:", error)
        }
    }
}

export function normalizeHistory(queries: readonly string[]): string[] {
    const result: string[] = []
    const seen = new Set<string>()
    for (const query of queries) {
        if (typeof query !== "string") continue
        const trimmed = query.trim()
        const normalized = trimmed.toLocaleLowerCase()
        if (!trimmed || seen.has(normalized)) continue
        seen.add(normalized)
        result.push(trimmed)
        if (result.length === HISTORY_LIMIT) break
    }
    return result
}
