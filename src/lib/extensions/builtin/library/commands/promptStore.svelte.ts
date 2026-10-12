import Fuse from "fuse.js"
import type { StorageNamespace } from "$lib/extension-api"
import type { PromptItem, PromptRequest, PromptService, PromptSnapshot } from "./prompt.types"

const MAX_QUERY_HISTORY = 50
const QUERY_HISTORY_STORAGE_KEY = "prompt.query-history"
import * as m from "$lib/paraglide/messages"

type PersistedQueryHistory = {
    lastQuery?: unknown
    retainedQueries?: unknown
}

let promptStorage: StorageNamespace | undefined

export function configurePromptStorage(storage: StorageNamespace | undefined): void {
    promptStorage = storage
    if (!storage) return
    void storage.get<PersistedQueryHistory>(QUERY_HISTORY_STORAGE_KEY).then((stored) => {
        if (!stored || typeof stored !== "object") return
        if (typeof stored.lastQuery === "string")
            promptStore.setLastQueryFromStorage(stored.lastQuery)
        if (!stored.retainedQueries || typeof stored.retainedQueries !== "object") return
        for (const [requestId, queries] of Object.entries(stored.retainedQueries)) {
            if (!Array.isArray(queries)) continue
            const validQueries = queries.filter(
                (query): query is string => typeof query === "string" && query !== "",
            )
            if (validQueries.length > 0)
                promptStore.setRetainedQueriesFromStorage(
                    requestId,
                    validQueries.slice(-MAX_QUERY_HISTORY),
                )
        }
    })
}

const PROMPT_FUSE_OPTIONS = {
    keys: [
        { name: "label", weight: 0.7 },
        { name: "englishLabel", weight: 0.6 },
        { name: "description", weight: 0.3 },
        { name: "englishDescription", weight: 0.2 },
        { name: "category", weight: 0.1 },
    ],
    threshold: 0.4,
}

type ErasedRequest = PromptRequest<unknown>
type SessionKind = "open" | "choose"
type Session = {
    request: ErasedRequest
    kind: SessionKind
    sourceItems: PromptItem<unknown>[]
    resolve: (value: unknown) => void
}
type PromptFrame = {
    session: Session
    snapshot: PromptSnapshot
    query: string
    manualSelectedIndex: number | null
    currentHistoryIndex: number | null
    retainedQueriesLocal: string[]
    draftQuery: string
}

class PromptStore implements PromptService {
    snapshot = $state.raw<PromptSnapshot | null>(null)
    private session: Session | null = null
    private suspendedFrames: PromptFrame[] = []
    private selectingSessions = new Set<Session>()
    private retainedQueries = new Map<string, string[]>()
    private requestVersion = 0
    private manualSelectedIndex: number | null = null
    query: string = ""
    private lastQuery: string = ""
    currentHistoryIndex: number | null = null
    retainedQueriesLocal: string[] = []
    private draftQuery: string = ""

    constructor() {
        this.restoreQueryHistory()
    }

    private restoreQueryHistory(): void {
        // Storage is configured by the library extension after activation.
    }

    setLastQueryFromStorage(query: string): void {
        this.lastQuery = query
    }

    setRetainedQueriesFromStorage(requestId: string, queries: string[]): void {
        this.retainedQueries.set(requestId, queries)
    }

    private persistQueryHistory(): void {
        if (!promptStorage) return
        void promptStorage.set(QUERY_HISTORY_STORAGE_KEY, {
            lastQuery: this.lastQuery,
            retainedQueries: Object.fromEntries(this.retainedQueries),
        })
    }

    setLastQuery(query: string): void {
        this.lastQuery = query
        this.persistQueryHistory()
    }

    getLastQuery(): string {
        return this.lastQuery
    }

    getQuery(): string {
        return this.query
    }

    get isOpen() {
        return this.snapshot !== null
    }

    get canNavigateBack() {
        return this.suspendedFrames.length > 0 && this.query === ""
    }

    open<T>(request: PromptRequest<T>): Promise<void> {
        return this.start(request, "open") as Promise<void>
    }

    choose<T>(request: PromptRequest<T>): Promise<T | undefined> {
        return this.start(request, "choose") as Promise<T | undefined>
    }

    private start<T>(request: PromptRequest<T>, kind: SessionKind): Promise<unknown> {
        const isExpectedChild =
            this.session === null &&
            this.suspendedFrames.some(({ session }) => this.selectingSessions.has(session))
        if (!isExpectedChild) this.cancelFlow()

        this.currentHistoryIndex = null
        this.query =
            request.initialQuery !== undefined
                ? request.initialQuery
                : request.restoreQuery
                  ? this.getLastQuery()
                  : ""

        return new Promise<unknown>((resolve) => {
            this.session = {
                request: request as ErasedRequest,
                kind,
                sourceItems: [],
                resolve,
            }
            this.manualSelectedIndex = null
            this.snapshot = {
                request: request as ErasedRequest,
                query: this.query,
                items: [],
                selectedIndex: -1,
                isLoading: true,
            }

            const retainedQueries = this.retainedQueries.get(this.session.request.id) ?? []
            this.retainedQueriesLocal = [...retainedQueries]
            this.currentHistoryIndex = this.retainedQueriesLocal.length
            this.draftQuery = this.query
            void this.refreshItems()
        })
    }

    close() {
        if (this.query === "") {
            this.setLastQuery(this.query)
        } else if (this.currentHistoryIndex === this.retainedQueriesLocal.length) {
            this.setLastQuery(this.query)
        }

        this.currentHistoryIndex = null
        this.cancelFlow()
    }

    private resolveActive(value?: unknown) {
        this.requestVersion += 1
        const session = this.session
        this.session = null
        this.snapshot = null
        if (session) session.resolve(session.kind === "choose" ? value : undefined)
    }

    private cancelFlow() {
        this.resolveActive()
        const frames = this.suspendedFrames.splice(0)
        for (const { session } of frames) session.resolve(undefined)
        this.selectingSessions.clear()
    }

    private suspendCurrent(): PromptFrame | null {
        if (!this.session || !this.snapshot) return null
        this.requestVersion += 1
        const frame: PromptFrame = {
            session: this.session,
            snapshot: this.snapshot,
            query: this.query,
            manualSelectedIndex: this.manualSelectedIndex,
            currentHistoryIndex: this.currentHistoryIndex,
            retainedQueriesLocal: [...this.retainedQueriesLocal],
            draftQuery: this.draftQuery,
        }
        this.suspendedFrames.push(frame)
        this.session = null
        this.snapshot = null
        return frame
    }

    navigateBack(): void {
        if (!this.canNavigateBack) return
        this.resolveActive()
        const frame = this.suspendedFrames.pop()
        if (!frame) return
        this.requestVersion += 1
        this.session = frame.session
        this.snapshot = frame.snapshot
        this.query = frame.query
        this.manualSelectedIndex = frame.manualSelectedIndex
        this.currentHistoryIndex = frame.currentHistoryIndex
        this.retainedQueriesLocal = [...frame.retainedQueriesLocal]
        this.draftQuery = frame.draftQuery
    }

    setQuery(query: string) {
        this.applyQuery(query, true)
    }

    private applyQuery(query: string, resetHistoryIndex: boolean) {
        const session = this.session
        const snapshot = this.snapshot
        if (!session || !snapshot) return
        if (resetHistoryIndex) {
            this.draftQuery = query
            this.currentHistoryIndex = this.retainedQueriesLocal.length
        }
        this.manualSelectedIndex = null
        this.query = query
        this.snapshot = { ...snapshot, query, selectedIndex: -1 }
        session.request.onQueryChange?.(query)
        void this.refreshItems()
    }

    refresh() {
        if (this.snapshot) void this.refreshItems()
    }

    moveSelection(offset: number) {
        const snapshot = this.snapshot
        if (!snapshot || snapshot.items.length === 0) return
        const current = snapshot.selectedIndex < 0 ? 0 : snapshot.selectedIndex
        this.manualSelectedIndex =
            (current + offset + snapshot.items.length) % snapshot.items.length
        this.snapshot = { ...snapshot, selectedIndex: this.manualSelectedIndex }
    }

    async selectCurrent(): Promise<void> {
        const session = this.session
        const snapshot = this.snapshot
        if (!session || !snapshot) return

        const parsed = session.request.parseQuery?.(snapshot.query)
        const selected = snapshot.items[snapshot.selectedIndex]
        const value = parsed ?? selected?.value
        if (value === undefined) return

        this.setLastQuery(this.query)
        if (session.kind === "choose") {
            this.resolveActive(value)
            return
        }

        if (session.request.rememberQuery && this.query !== "") {
            const retainedQueries = this.retainedQueries.get(session.request.id) ?? []
            if (retainedQueries.at(-1) !== this.query) retainedQueries.push(this.query)
            const nextRetainedQueries = retainedQueries.slice(-MAX_QUERY_HISTORY)
            this.retainedQueries.set(session.request.id, nextRetainedQueries)
            this.retainedQueriesLocal = [...nextRetainedQueries]
            this.currentHistoryIndex = this.retainedQueriesLocal.length
            this.draftQuery = this.query
            this.persistQueryHistory()
        }

        const closeBeforeSelect = session.request.closeOnSelect !== false
        const controls = {
            close: () => this.close(),
            setQuery: (query: string) => this.setQuery(query),
        }
        if (closeBeforeSelect) {
            this.selectingSessions.add(session)
            this.suspendCurrent()
        }
        const behavior = (await session.request.onSelect?.(value, controls)) ?? "close"
        this.selectingSessions.delete(session)

        if (closeBeforeSelect) {
            if (this.session === session) return
            if (this.suspendedFrames.some((frame) => frame.session === session)) this.cancelFlow()
        } else if (behavior === "close") {
            this.close()
        }
    }

    historyForward(): void {
        if (!this.snapshot || this.currentHistoryIndex === null) return
        const nextIndex = Math.min(this.currentHistoryIndex + 1, this.retainedQueriesLocal.length)
        if (nextIndex === this.currentHistoryIndex) return
        this.currentHistoryIndex = nextIndex
        const nextItem =
            nextIndex === this.retainedQueriesLocal.length
                ? this.draftQuery
                : this.retainedQueriesLocal[nextIndex]
        if (nextItem !== this.query) this.applyQuery(nextItem, false)
    }

    historyBack(): void {
        if (!this.snapshot || this.currentHistoryIndex === null) return
        let nextIndex = this.currentHistoryIndex - 1
        while (nextIndex >= 0 && this.retainedQueriesLocal[nextIndex] === this.query) {
            nextIndex -= 1
        }
        if (nextIndex < 0) return
        this.currentHistoryIndex = nextIndex
        this.applyQuery(this.retainedQueriesLocal[nextIndex], false)
    }

    private async refreshItems() {
        const session = this.session
        const snapshot = this.snapshot
        if (!session || !snapshot) return
        const version = ++this.requestVersion
        const selectedItemId = snapshot.items[snapshot.selectedIndex]?.id
        const provider = session.request.items
        this.snapshot = { ...snapshot, isLoading: true, errorLabel: undefined }

        let resolved: PromptItem<unknown>[]
        try {
            resolved = await Promise.resolve(provider(this.query))
        } catch (error) {
            if (version !== this.requestVersion || session !== this.session || !this.snapshot)
                return
            this.snapshot = {
                ...this.snapshot,
                items: [],
                selectedIndex: -1,
                isLoading: false,
                errorLabel: session.request.errorLabel ?? m.prompt_options_load_failed(),
            }
            try {
                session.request.onItemsError?.(error)
            } catch {
                // Error callbacks are observational and must not break Prompt recovery.
            }
            return
        }
        if (version !== this.requestVersion || session !== this.session || !this.snapshot) return
        session.sourceItems = resolved

        let items = resolved
        if (session.request.filter !== "none" && this.query.trim()) {
            items = new Fuse(resolved, PROMPT_FUSE_OPTIONS)
                .search(this.query.trim())
                .map(({ item }) => item)
        }

        let automaticIndex = items.length > 0 ? 0 : -1
        if (this.manualSelectedIndex === null && session.request.initialSelection) {
            automaticIndex = session.request.initialSelection(items)
        }
        const preservedSelection = selectedItemId
            ? items.findIndex((item) => item.id === selectedItemId)
            : -1
        const selectedIndex =
            items.length === 0
                ? -1
                : this.manualSelectedIndex !== null && preservedSelection >= 0
                  ? preservedSelection
                  : this.manualSelectedIndex !== null && this.manualSelectedIndex < items.length
                    ? this.manualSelectedIndex
                    : Math.max(0, Math.min(automaticIndex, items.length - 1))

        this.snapshot = {
            ...this.snapshot,
            items,
            selectedIndex,
            isLoading: session.request.isLoading?.() ?? false,
            errorLabel: undefined,
        }
    }
}

export const promptStore = new PromptStore()

export type {
    PromptItem,
    PromptItems,
    PromptRequest,
    PromptSelectionBehavior,
    PromptService,
    PromptSnapshot,
} from "./prompt.types"
