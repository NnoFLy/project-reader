import type { ProviderAvailability, ProviderSnapshot } from "$lib/extension-api/providers"
import type { ViewerDocument } from "./viewerDocument"
import { isDocumentId, readState, readAnnotations } from "./readingStorage"
import { DocumentAccess, DocumentAccessUnavailableError } from "$lib/core/documents/document-access"
import type { ViewerFileCapability } from "./viewerHost"
import type { ViewerDocumentLoader } from "./viewerDocument"
import { fileNodeToBook, type Book } from "./stores/viewerStore.types"
import {
    ReadingStorageError,
    type ReadingDocumentState,
    type ReadingLayout,
    type ReadingStorage,
} from "./readingStorage"

import {
    freezeAnnotations,
    isAnnotationId,
    readNote,
    readBookmark,
    type ReadingBookmark,
    type ReadingBookmarkInput,
    type ReadingRecords,
    type ReadingDraft,
    type ReadingNote,
    type ReadingNoteInput,
} from "./readingAnnotations"

export type ReadingReviewItem =
    | { readonly kind: "note" | "draft"; readonly record: ReadingNote }
    | { readonly kind: "bookmark"; readonly record: ReadingBookmark }

export type ReadingMutationResult<T> =
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly error: ReadingStorageError; readonly value?: T }

export interface ReadingAnnotationSnapshot extends ReadingRecords {
    readonly loaded: boolean
    readonly dirty: boolean
    readonly error: ReadingStorageError["code"] | null
}

export interface ReadingCloseToken {
    readonly documentId: string
    readonly selectionRevision: number
    readonly draftRevision: number
}

export type ReadingCloseResult =
    | { readonly status: "closed" | "cancelled" | "superseded" | "changed" }
    | { readonly status: "failed"; readonly error: ReadingStorageError }

export type ReadingCloseRequest =
    | ReadingCloseResult
    | { readonly status: "confirmation-required"; readonly token: ReadingCloseToken }

export interface ReadingSummary {
    readonly documentId: string
    readonly noteCount: number
    readonly bookmarkCount: number
}

type AnnotationListener = (documentId: string, snapshot: ReadingAnnotationSnapshot) => void
const EMPTY_ANNOTATIONS: ReadingAnnotationSnapshot = Object.freeze({
    ...freezeAnnotations([]),
    loaded: false,
    dirty: false,
    error: null,
})

export interface ViewerOpenFailure {
    readonly bookId: string
    readonly error: unknown
}

export interface ReadingSnapshot {
    readonly documentId: string | null
    readonly state: ReadingDocumentState
    readonly status: "closed" | "ready" | "unavailable" | "missing" | "provider-unavailable"
}

export interface ReadingRecoveryRecord {
    readonly documentId: string | null
    readonly promotions: readonly {
        readonly documentId: string
        readonly drafts: readonly ReadingDraft[]
        /** Discards accepted while the originating physical promotion was pending. */
        readonly discardedDraftIds: readonly string[]
    }[]
    readonly states: readonly {
        readonly documentId: string
        readonly state: ReadingDocumentState
    }[]
    readonly annotations: readonly {
        readonly documentId: string
        readonly records: ReadingRecords
        readonly dirty: boolean
    }[]
}

export interface ReadingWorkspaceOptions {
    readonly providers?: ProviderAvailability
    readonly recovery?: ReadingRecoveryRecord
    readonly files: ViewerFileCapability
    readonly loader?: ViewerDocumentLoader
    readonly storage?: ReadingStorage
    readonly writeSignal?: AbortSignal
    readonly defaults?: () => Pick<ReadingDocumentState, "scale" | "layout">
    readonly onChange?: (snapshot: ReadingSnapshot) => void
    readonly onStorageError?: (error: ReadingStorageError) => void
    readonly getCurrentBook: () => Book | null
    /** Synchronous, atomic publication: false or a throw rejects ownership transfer. */
    readonly publish: (book: Book | null) => boolean | void
}

interface PendingDraftPromotion {
    readonly drafts: readonly ReadingDraft[]
    readonly discardedDraftIds: Set<string>
    readonly recovering: boolean
}

/** Viewer-owned single-reader behavior; core owns acquisition and resource correctness. */
export class ReadingWorkspace {
    private readonly access: DocumentAccess
    private intendedId: string | null = null
    private retryRevision?: number
    private resourceController = new AbortController()
    private readonly documentViews = new WeakMap<
        ViewerDocument,
        { controller: AbortController; view: ViewerDocument }
    >()
    private readonly providerWatches = new Map<string, () => void>()
    private providerSubscription?: { dispose(): void }
    private synchronization?: Promise<void>
    private relinkPending = false
    private storage?: ReadingStorage
    private revision = 0
    private disposed = false
    private writesClosed = false
    private disposal?: Promise<void>
    private queue: Promise<void> = Promise.resolve()
    private readonly states = new Map<string, ReadingDocumentState>()
    private current: ReadingSnapshot
    private readonly contentIdentities = new Map<
        string,
        { generation: number; hash: string | null }
    >()
    private readonly annotationStates = new Map<string, ReadingAnnotationSnapshot>()
    private readonly annotationListeners = new Set<AnnotationListener>()
    private readonly annotationEpochs = new Map<string, number>()
    private readonly annotationLoads = new Map<
        string,
        { readonly owns: () => boolean; readonly promise: Promise<boolean> }
    >()
    private readonly draftRevisions = new Map<string, number>()
    private readonly closeTokens = new WeakSet<ReadingCloseToken>()
    private readonly draftLoads = new Map<string, Promise<boolean>>()
    private readonly invalidAnnotations = new Set<string>()
    private readonly pendingPromotions = new Map<string, PendingDraftPromotion>()
    private readonly recoveryConflicts = new Set<string>()
    private recoveryReconciliation?: Promise<boolean>

    /** Monotonic selection intent, including acquisitions that have not published yet. */
    get selectionRevision(): number {
        return this.revision
    }

    constructor(private readonly options: ReadingWorkspaceOptions) {
        this.access = new DocumentAccess(options.files)
        this.storage = options.storage
        this.current = { documentId: null, state: this.defaultState(), status: "closed" }
        this.providerSubscription = options.providers?.onDidChange((provider) =>
            this.observeProvider(provider),
        )
        this.watchProvider("builtin.library")
        if (options.recovery) this.restoreRecovery(options.recovery)
    }

    /** Data only: validated copies never transfer a disposed resource or callback lifetime. */
    captureRecovery(): ReadingRecoveryRecord | undefined {
        if (this.revision === 0 && this.intendedId === null) return undefined
        const states = [...this.states].flatMap(([documentId, state]) => {
            const validated = readState(state as unknown as Record<string, unknown>)
            return isDocumentId(documentId) && validated
                ? [Object.freeze({ documentId, state: Object.freeze(validated) })]
                : []
        })
        const annotations = [...this.annotationStates].flatMap(([documentId, snapshot]) => {
            const records = readAnnotations(snapshot, documentId)
            return snapshot.loaded && snapshot.dirty && isDocumentId(documentId) && records
                ? [Object.freeze({ documentId, records, dirty: snapshot.dirty })]
                : []
        })
        const promotions = [...this.pendingPromotions].flatMap(([documentId, promotion]) => {
            const records = readAnnotations(
                { notes: [], bookmarks: [], drafts: promotion.drafts },
                documentId,
            )
            return records
                ? [
                      Object.freeze({
                          documentId,
                          drafts: records.drafts,
                          discardedDraftIds: Object.freeze(
                              records.drafts
                                  .filter((draft) => promotion.discardedDraftIds.has(draft.id))
                                  .map((draft) => draft.id),
                          ),
                      }),
                  ]
                : []
        })
        return Object.freeze({
            documentId: this.intendedId,
            promotions: Object.freeze(promotions),
            states: Object.freeze(states),
            annotations: Object.freeze(annotations),
        })
    }

    private restoreRecovery(record: ReadingRecoveryRecord): void {
        for (const item of record.states) {
            const state = readState(item.state as unknown as Record<string, unknown>)
            if (isDocumentId(item.documentId) && state)
                this.states.set(item.documentId, Object.freeze(state))
        }
        for (const item of record.annotations) {
            const records = readAnnotations(item.records, item.documentId)
            if (isDocumentId(item.documentId) && records)
                this.publishAnnotations(item.documentId, records, true, item.dirty)
        }
        for (const item of record.promotions) {
            const records = readAnnotations(
                { notes: [], bookmarks: [], drafts: item.drafts },
                item.documentId,
            )
            if (isDocumentId(item.documentId) && records)
                this.pendingPromotions.set(item.documentId, {
                    drafts: records.drafts,
                    discardedDraftIds: new Set(
                        Array.isArray(item.discardedDraftIds)
                            ? item.discardedDraftIds.filter(
                                  (id) =>
                                      isAnnotationId(id) &&
                                      records.drafts.some((draft) => draft.id === id),
                              )
                            : [],
                    ),
                    recovering: true,
                })
        }
        this.revision++
        this.intendedId = isDocumentId(record.documentId) ? record.documentId : null
        const knownState = this.states.get(this.intendedId ?? "")
        this.change(
            this.intendedId,
            knownState ?? this.defaultState(),
            this.intendedId ? "provider-unavailable" : "closed",
        )
        if (this.intendedId && !knownState) this.states.delete(this.intendedId)
    }

    private async reconcileRecovery(): Promise<boolean> {
        if (!this.storage) return false
        for (const [documentId, promotion] of this.pendingPromotions) {
            if (!promotion.recovering) continue
            const snapshot = this.annotations(documentId)
            if (!snapshot.dirty) {
                this.pendingPromotions.delete(documentId)
                this.recoveryConflicts.delete(documentId)
                continue
            }
            try {
                const durable = await this.storage.readAnnotations(documentId)
                if (this.disposed) return false
                if (this.pendingPromotions.get(documentId) !== promotion) continue
                let records: ReadingRecords = this.annotations(documentId)
                let conflict = false
                for (const draft of promotion.drafts) {
                    // A discard accepted during the physical Save supersedes that promotion.
                    if (promotion.discardedDraftIds.has(draft.id)) continue
                    const saved = durable.notes.find((note) => note.id === draft.id)
                    if (!saved || JSON.stringify(saved) !== JSON.stringify(draft)) continue
                    const latest = records.drafts.find((item) => item.id === draft.id)
                    // Never silently overwrite a terminal promotion with edits accepted later.
                    if (latest && JSON.stringify(latest) !== JSON.stringify(draft)) {
                        conflict = true
                        continue
                    }
                    records = freezeAnnotations(
                        [...records.notes.filter((note) => note.id !== draft.id), saved],
                        records.bookmarks,
                        records.drafts.filter((item) => item.id !== draft.id),
                    )
                }
                if (conflict) this.recoveryConflicts.add(documentId)
                else this.recoveryConflicts.delete(documentId)
                this.publishAnnotations(
                    documentId,
                    records,
                    true,
                    true,
                    conflict ? "reading.storage.write" : null,
                )
                if (!conflict) this.pendingPromotions.delete(documentId)
            } catch {
                // Retain the handoff until a later explicit retry can inspect terminal storage.
                return false
            }
        }
        return !this.recoveryConflicts.size
    }

    private requiredProviders(id = this.intendedId): readonly string[] {
        const name = id && this.options.files.nodes[id]?.name
        return [
            "builtin.library",
            ...(name ? (this.options.loader?.requiredProviders?.(name) ?? []) : []),
        ]
    }

    private watchProvider(id: string): void {
        const provider = this.options.providers?.get(id)
        if (provider) this.observeProvider(provider)
    }

    private observeProvider(provider: ProviderSnapshot): void {
        if (this.disposed || !this.requiredProviders().includes(provider.extensionId)) return
        this.providerWatches.get(provider.extensionId)?.()
        const unavailable = () => {
            if (this.requiredProviders().includes(provider.extensionId)) this.providerUnavailable()
        }
        provider.signal.addEventListener("abort", unavailable, { once: true })
        this.providerWatches.set(provider.extensionId, () =>
            provider.signal.removeEventListener("abort", unavailable),
        )
        if (
            provider.signal.aborted ||
            provider.state === "disabled" ||
            provider.state === "failed" ||
            provider.state === "disposed"
        )
            unavailable()
    }

    private providersAvailable(): boolean {
        return this.requiredProviders().every((id) => {
            const provider = this.options.providers?.get(id)
            // Format providers may still be lazily registered; loader activates them.
            return (
                !provider ||
                (!provider.signal.aborted &&
                    (provider.state === "active" ||
                        (id !== "builtin.library" &&
                            ["enabled", "installed", "discovered", "activating"].includes(
                                provider.state,
                            ))))
            )
        })
    }

    private providerUnavailable(): void {
        if (this.disposed || !this.intendedId) return
        this.revision++
        this.resourceController.abort()
        const closing = this.access.close()
        this.options.publish(null)
        const knownState = this.states.get(this.intendedId)
        this.change(this.intendedId, knownState ?? this.defaultState(), "provider-unavailable")
        if (!knownState) this.states.delete(this.intendedId)
        // Unknown pending state must be hydrated on retry, not overwritten with defaults.
        if (knownState) this.save(true)
        void this.bounded(closing).catch(() => undefined)
    }

    get snapshot(): ReadingSnapshot {
        return this.current
    }

    annotations(documentId: string): ReadingAnnotationSnapshot {
        return this.annotationStates.get(documentId) ?? EMPTY_ANNOTATIONS
    }

    private contentHash(documentId: string): string | null {
        if (this.current.documentId === documentId && this.current.status !== "ready") return null
        const identity = this.contentIdentities.get(documentId)
        return identity && this.options.files.isCurrentContent(documentId, identity.generation)
            ? identity.hash
            : null
    }

    /** Only controlled equality evidence permits an anchor to reach document text. */
    anchoredAnnotations(documentId: string): ReadingRecords {
        const hash = this.contentHash(documentId)
        const matches = (record: ReadingNote | ReadingBookmark) =>
            hash !== null && record.association.contentHash === hash
        const records = this.annotations(documentId)
        return freezeAnnotations(
            records.notes.filter(matches),
            records.bookmarks.filter(matches),
            records.drafts.filter(matches),
        )
    }

    needsReview(documentId: string): readonly ReadingReviewItem[] {
        const hash = this.contentHash(documentId)
        const records = this.annotations(documentId)
        const items: ReadingReviewItem[] = [
            ...records.notes.map((record) => ({ kind: "note" as const, record })),
            ...records.drafts.map((record) => ({ kind: "draft" as const, record })),
            ...records.bookmarks.map((record) => ({ kind: "bookmark" as const, record })),
        ]
        return Object.freeze(
            items.filter(({ record }) => hash === null || record.association.contentHash !== hash),
        )
    }

    async discardReviewItem(
        documentId: string,
        kind: ReadingReviewItem["kind"],
        id: string,
    ): Promise<ReadingMutationResult<void>> {
        if (
            !(await this.loadDraftsForMutation(documentId)) ||
            !this.needsReview(documentId).some(
                (item) => item.kind === kind && item.record.id === id,
            )
        )
            return { ok: false, error: new ReadingStorageError("reading.storage.invalid-input") }
        if (kind === "draft") return this.discardDraft(documentId, id)
        // Review material remains editable even when its source resources are unavailable.
        const owns = this.draftOwnership(documentId)
        if (!owns) return { ok: false, error: new ReadingStorageError("reading.storage.write") }
        const records = this.annotations(documentId)
        this.publishAnnotations(
            documentId,
            freezeAnnotations(
                records.notes.filter((record) => kind !== "note" || record.id !== id),
                records.bookmarks.filter((record) => kind !== "bookmark" || record.id !== id),
                records.drafts,
            ),
            true,
            true,
        )
        return this.persistAnnotations(documentId, undefined, owns)
    }

    private associateNew<T extends ReadingNote | ReadingBookmark>(
        documentId: string,
        record: T | null,
    ): T | null {
        if (!record) return null
        return Object.freeze<T>({
            ...record,
            association: Object.freeze({
                contentHash: this.contentHash(documentId),
                verification: "unverified" as const,
            }),
        })
    }

    subscribeAnnotations(listener: AnnotationListener): () => void {
        if (!this.disposed) this.annotationListeners.add(listener)
        return () => this.annotationListeners.delete(listener)
    }

    private draftOwnership(documentId: string): (() => boolean) | null {
        if (
            typeof documentId !== "string" ||
            !documentId.trim() ||
            documentId.length > 1024 ||
            Array.from(documentId).some((character) => {
                const code = character.charCodeAt(0)
                return code < 32 || code === 127
            }) ||
            this.disposed ||
            this.writesClosed ||
            this.options.writeSignal?.aborted
        )
            return null
        // Draft lifetime is independent of resources and annotation invalidation epochs.
        return () => !this.writesClosed && !this.options.writeSignal?.aborted
    }

    /** Recover unfinished work even when Library resources are missing or unavailable. */
    async loadDrafts(documentId: string): Promise<boolean> {
        const owns = this.draftOwnership(documentId)
        if (!owns) return false
        if (this.annotations(documentId).loaded) return true
        try {
            if (!this.storage) throw new ReadingStorageError("reading.storage.read")
            const state = await this.storage.readAnnotations(documentId)
            if (this.disposed || !owns()) return false
            if (!this.annotations(documentId).loaded)
                this.publishAnnotations(documentId, state, true, false)
            return true
        } catch (error) {
            if (!this.disposed && owns() && !this.annotations(documentId).loaded) {
                this.publishAnnotations(
                    documentId,
                    this.annotations(documentId),
                    false,
                    false,
                    "reading.storage.read",
                )
                this.report(error, "reading.storage.read")
            }
            return false
        }
    }

    private loadDraftsForMutation(documentId: string): Promise<boolean> {
        const pending = this.draftLoads.get(documentId)
        if (pending) return pending
        const promise = this.loadDrafts(documentId).finally(() => {
            if (this.draftLoads.get(documentId) === promise) this.draftLoads.delete(documentId)
        })
        this.draftLoads.set(documentId, promise)
        return promise
    }

    async createDraft(
        documentId: string,
        input: ReadingNoteInput,
    ): Promise<ReadingMutationResult<ReadingDraft>> {
        const lifetimeOwns = this.draftOwnership(documentId)
        const epoch = this.annotationEpochs.get(documentId) ?? 0
        const generation = this.options.files.getContentGeneration(documentId)
        const owns =
            lifetimeOwns &&
            (() =>
                lifetimeOwns() &&
                (this.annotationEpochs.get(documentId) ?? 0) === epoch &&
                this.options.files.getContentGeneration(documentId) === generation)

        const draft =
            owns &&
            this.associateNew(
                documentId,
                readNote(
                    {
                        ...input,
                        id: crypto.randomUUID(),
                        bookId: documentId,
                        createdAt: Date.now(),
                    },
                    documentId,
                ),
            )
        if (!owns || !draft)
            return { ok: false, error: new ReadingStorageError("reading.storage.invalid-input") }
        if (!this.annotations(documentId).loaded && !(await this.loadDraftsForMutation(documentId)))
            return {
                ok: false,
                error: new ReadingStorageError("reading.storage.read"),
                value: draft,
            }
        if (this.disposed || !owns())
            return { ok: false, error: new ReadingStorageError("reading.storage.write") }
        const current = this.annotations(documentId)
        const state = freezeAnnotations(current.notes, current.bookmarks, [
            ...current.drafts,
            draft,
        ])
        this.publishAnnotations(documentId, state, true, true)
        return this.persistAnnotations(documentId, draft, owns)
    }

    async updateDraft(
        documentId: string,
        draftId: string,
        changes: Pick<ReadingNoteInput, "noteContent" | "color">,
    ): Promise<ReadingMutationResult<ReadingDraft>> {
        const { noteContent, color } = changes
        const owns = this.draftOwnership(documentId)
        if (!owns || !isAnnotationId(draftId))
            return { ok: false, error: new ReadingStorageError("reading.storage.invalid-input") }
        if (!this.annotations(documentId).loaded && !(await this.loadDraftsForMutation(documentId)))
            return { ok: false, error: new ReadingStorageError("reading.storage.read") }
        if (this.disposed || !owns())
            return { ok: false, error: new ReadingStorageError("reading.storage.write") }
        const current = this.annotations(documentId)
        const previous = current.drafts.find((draft) => draft.id === draftId)
        const draft = previous && readNote({ ...previous, noteContent, color }, documentId)
        if (!draft)
            return { ok: false, error: new ReadingStorageError("reading.storage.invalid-input") }
        const state = freezeAnnotations(
            current.notes,
            current.bookmarks,
            current.drafts.map((item) => (item.id === draftId ? draft : item)),
        )
        this.publishAnnotations(documentId, state, true, true)
        return this.persistAnnotations(documentId, draft, owns)
    }

    async discardDraft(documentId: string, draftId: string): Promise<ReadingMutationResult<void>> {
        const owns = this.draftOwnership(documentId)
        if (!owns || !isAnnotationId(draftId))
            return { ok: false, error: new ReadingStorageError("reading.storage.invalid-input") }
        if (!this.annotations(documentId).loaded && !(await this.loadDraftsForMutation(documentId)))
            return { ok: false, error: new ReadingStorageError("reading.storage.read") }
        if (this.disposed || !owns())
            return { ok: false, error: new ReadingStorageError("reading.storage.write") }
        const current = this.annotations(documentId)
        const promotion = this.pendingPromotions.get(documentId)
        if (!promotion?.recovering && promotion?.drafts.some((draft) => draft.id === draftId))
            promotion.discardedDraftIds.add(draftId)
        const state = freezeAnnotations(
            current.notes,
            current.bookmarks,
            current.drafts.filter((draft) => draft.id !== draftId),
        )
        this.publishAnnotations(documentId, state, true, true)
        if (promotion?.recovering) {
            // Discard only the recovered unsaved edit, not the terminally saved note.
            // Wait for any earlier inspection before resolving against terminal storage.
            const previous = this.recoveryReconciliation
            this.recoveryReconciliation = (async () => {
                await previous
                if (this.disposed || !owns()) return false
                return this.reconcileRecovery()
            })()
            await this.recoveryReconciliation
            if (this.disposed || !owns() || this.pendingPromotions.has(documentId))
                return { ok: false, error: new ReadingStorageError("reading.storage.write") }
        }
        return this.persistAnnotations(documentId, undefined, owns)
    }

    /** Retry durable editing state, not an instruction to turn drafts into saved notes. */
    async persistDrafts(documentId: string): Promise<ReadingMutationResult<void>> {
        const owns = this.draftOwnership(documentId)
        if (!owns || this.pendingPromotions.has(documentId))
            return { ok: false, error: new ReadingStorageError("reading.storage.invalid-input") }
        if (!this.annotations(documentId).loaded && !(await this.loadDraftsForMutation(documentId)))
            return { ok: false, error: new ReadingStorageError("reading.storage.read") }
        if (this.disposed || !owns())
            return { ok: false, error: new ReadingStorageError("reading.storage.write") }
        return this.persistAnnotations(documentId, undefined, owns)
    }

    /** Explicit promotion through the authoritative saved-note envelope, never recovery. */
    async saveDraft(
        documentId: string,
        draftId: string,
    ): Promise<ReadingMutationResult<ReadingNote>> {
        const owns = this.draftOwnership(documentId)
        if (!owns || !isAnnotationId(draftId))
            return { ok: false, error: new ReadingStorageError("reading.storage.invalid-input") }
        if (!this.annotations(documentId).loaded && !(await this.loadDraftsForMutation(documentId)))
            return { ok: false, error: new ReadingStorageError("reading.storage.read") }
        if (this.disposed || !owns())
            return { ok: false, error: new ReadingStorageError("reading.storage.write") }
        const draft = this.annotations(documentId).drafts.find((item) => item.id === draftId)
        if (!draft)
            return { ok: false, error: new ReadingStorageError("reading.storage.invalid-input") }
        const result = await this.persistDraftNotes(documentId, [draft], owns)
        return result.ok ? { ok: true, value: draft } : { ...result, value: draft }
    }

    private async persistDraftNotes(
        documentId: string,
        drafts: readonly ReadingDraft[],
        owns: () => boolean,
    ): Promise<ReadingMutationResult<void>> {
        let result: ReadingMutationResult<void> = {
            ok: false,
            error: new ReadingStorageError("reading.storage.write"),
        }
        this.queue = this.queue.then(async () => {
            if (!owns()) return
            const before = this.annotations(documentId)
            // A discarded or edited snapshot may not be revived by a queued save.
            if (!drafts.every((draft) => before.drafts.includes(draft))) return
            const ids = new Set(drafts.map((draft) => draft.id))
            const state = freezeAnnotations(
                [...before.notes.filter((note) => !ids.has(note.id)), ...drafts],
                before.bookmarks,
                before.drafts.filter((draft) => !ids.has(draft.id)),
            )
            try {
                if (!this.storage) throw new ReadingStorageError("reading.storage.write")
                // Atomic replacement: no separate cleanup write can duplicate a saved note.
                this.pendingPromotions.set(documentId, {
                    drafts,
                    discardedDraftIds: new Set(),
                    recovering: false,
                })
                await this.storage.writeAnnotations(documentId, state)
                if (!owns()) return
                this.pendingPromotions.delete(documentId)
                this.recoveryConflicts.delete(documentId)
                const latest = this.annotations(documentId)
                // Edits retain draft identity; explicit discard removes it. The queued
                // discard write replaces this stale envelope without promoting abandoned work.
                if (!drafts.every((draft) => latest.drafts.some((item) => item.id === draft.id)))
                    return
                const notes = [...latest.notes]
                for (const draft of drafts) {
                    const previous = before.notes.find((note) => note.id === draft.id)
                    const index = notes.findIndex((note) => note.id === draft.id)
                    if (index < 0 && !previous) notes.push(draft)
                    else if (index >= 0 && notes[index] === previous) notes[index] = draft
                }
                const unchanged =
                    latest.notes === before.notes &&
                    latest.bookmarks === before.bookmarks &&
                    latest.drafts === before.drafts
                this.publishAnnotations(
                    documentId,
                    freezeAnnotations(
                        notes,
                        latest.bookmarks,
                        latest.drafts.filter((draft) => !drafts.includes(draft)),
                    ),
                    true,
                    !unchanged,
                )
                result = { ok: true, value: undefined }
            } catch (error) {
                if (!owns()) return
                this.pendingPromotions.delete(documentId)
                this.report(error, "reading.storage.write")
                this.publishAnnotations(
                    documentId,
                    this.annotations(documentId),
                    true,
                    true,
                    "reading.storage.write",
                )
            }
        })
        await this.queue
        return result
    }

    async getReadingSummary(documentId: string): Promise<ReadingSummary | null> {
        if (!(await this.loadAnnotations(documentId))) return null
        const state = this.annotations(documentId)
        return Object.freeze({
            documentId,
            noteCount: state.notes.length,
            bookmarkCount: state.bookmarks.length,
        })
    }

    private publishAnnotations(
        documentId: string,
        state: ReadingRecords,
        loaded: boolean,
        dirty: boolean,
        error: ReadingStorageError["code"] | null = null,
    ): void {
        if (this.disposed) return
        const previous = this.annotations(documentId).drafts
        if (
            previous.length !== state.drafts.length ||
            previous.some((draft, index) => draft !== state.drafts[index])
        )
            this.draftRevisions.set(documentId, (this.draftRevisions.get(documentId) ?? 0) + 1)
        const snapshot = Object.freeze({ ...state, loaded, dirty, error })
        this.annotationStates.set(documentId, snapshot)
        for (const listener of this.annotationListeners) listener(documentId, snapshot)
    }

    private loadAnnotationsForMutation(documentId: string): Promise<boolean> {
        const owns = this.annotationOwnership(documentId)
        if (!owns) return Promise.resolve(false)
        const pending = this.annotationLoads.get(documentId)
        // Share mutation hydration so edits resume in initiation order, even if a
        // separate reader load publishes before this hydration completes.
        if (pending?.owns()) return pending.promise
        const promise = this.loadAnnotations(documentId).finally(() => {
            if (this.annotationLoads.get(documentId)?.promise === promise)
                this.annotationLoads.delete(documentId)
        })
        this.annotationLoads.set(documentId, { owns, promise })
        return promise
    }

    async loadAnnotations(documentId: string): Promise<boolean> {
        const owns = this.annotationOwnership(documentId)
        if (!owns) return false
        if (this.annotations(documentId).loaded) return true
        try {
            if (!this.storage) throw new ReadingStorageError("reading.storage.read")
            const state = await this.storage.readAnnotations(documentId)
            if (this.disposed || !owns()) return false
            // A newer load or mutation owns the cache once published.
            if (!this.annotations(documentId).loaded)
                this.publishAnnotations(documentId, state, true, false)
            return true
        } catch (error) {
            if (!this.disposed && owns() && !this.annotations(documentId).loaded) {
                this.publishAnnotations(
                    documentId,
                    this.annotations(documentId),
                    false,
                    false,
                    "reading.storage.read",
                )
                this.report(error, "reading.storage.read")
            }
            return false
        }
    }

    /** Adapter deletion/invalidation fence. Neither discards work nor deletes durable data. */
    invalidateAnnotations(documentId: string): void {
        if (this.disposed) return
        this.annotationEpochs.set(documentId, (this.annotationEpochs.get(documentId) ?? 0) + 1)
        this.invalidAnnotations.add(documentId)
        this.contentIdentities.delete(documentId)
        if (this.current.documentId === documentId) {
            this.resourceController.abort()
            this.resourceController = new AbortController()
        }
        const state = this.annotations(documentId)
        if (state.loaded)
            this.publishAnnotations(documentId, state, state.loaded, state.dirty, state.error)
    }

    /** Only an adapter-confirmed available identity/rollback may resume new annotation writes. */
    resumeAnnotations(documentId: string): void {
        if (!this.disposed && this.options.files.nodes[documentId]?.type === "file")
            this.invalidAnnotations.delete(documentId)
    }

    private annotationOwnership(documentId: string): (() => boolean) | null {
        if (
            typeof documentId !== "string" ||
            !documentId.trim() ||
            documentId.length > 1024 ||
            Array.from(documentId).some((character) => {
                const code = character.charCodeAt(0)
                return code < 32 || code === 127
            })
        )
            return null
        const node = this.options.files.nodes[documentId]
        if (
            this.disposed ||
            this.invalidAnnotations.has(documentId) ||
            this.options.writeSignal?.aborted ||
            !node ||
            node.type !== "file"
        )
            return null
        const generation = this.options.files.getContentGeneration(documentId)
        const epoch = this.annotationEpochs.get(documentId) ?? 0
        return () =>
            !this.writesClosed &&
            !this.options.writeSignal?.aborted &&
            !this.invalidAnnotations.has(documentId) &&
            (this.annotationEpochs.get(documentId) ?? 0) === epoch &&
            this.options.files.nodes[documentId] === node &&
            this.options.files.getContentGeneration(documentId) === generation
    }

    async createNote(
        documentId: string,
        input: ReadingNoteInput,
    ): Promise<ReadingMutationResult<ReadingNote>> {
        const owns = this.annotationOwnership(documentId)
        if (!owns)
            return { ok: false, error: new ReadingStorageError("reading.storage.invalid-input") }
        const note = this.associateNew(
            documentId,
            readNote(
                { ...input, id: crypto.randomUUID(), bookId: documentId, createdAt: Date.now() },
                documentId,
            ),
        )
        if (!note)
            return { ok: false, error: new ReadingStorageError("reading.storage.invalid-input") }
        if (
            !this.annotations(documentId).loaded &&
            !(await this.loadAnnotationsForMutation(documentId))
        )
            return {
                ok: false,
                error: new ReadingStorageError("reading.storage.read"),
                value: note,
            }
        if (this.disposed || !owns())
            return { ok: false, error: new ReadingStorageError("reading.storage.write") }
        const state = freezeAnnotations(
            [...this.annotations(documentId).notes, note],
            this.annotations(documentId).bookmarks,
            this.annotations(documentId).drafts,
        )
        this.publishAnnotations(documentId, state, true, true)
        return this.persistAnnotations(documentId, note, owns)
    }

    async updateNote(
        documentId: string,
        noteId: string,
        changes: Pick<ReadingNoteInput, "noteContent" | "color">,
    ): Promise<ReadingMutationResult<ReadingNote>> {
        const { noteContent, color } = changes
        const owns = this.annotationOwnership(documentId)
        if (!owns)
            return { ok: false, error: new ReadingStorageError("reading.storage.invalid-input") }
        if (
            !this.annotations(documentId).loaded &&
            !(await this.loadAnnotationsForMutation(documentId))
        )
            return { ok: false, error: new ReadingStorageError("reading.storage.read") }
        if (this.disposed || !owns())
            return { ok: false, error: new ReadingStorageError("reading.storage.write") }
        const current = this.annotations(documentId)
        const previous = current.notes.find((note) => note.id === noteId)
        const note = previous && readNote({ ...previous, noteContent, color }, documentId)
        if (!note)
            return { ok: false, error: new ReadingStorageError("reading.storage.invalid-input") }
        const state = freezeAnnotations(
            current.notes.map((item) => (item.id === noteId ? note : item)),
            current.bookmarks,
            current.drafts,
        )
        this.publishAnnotations(documentId, state, true, true)
        return this.persistAnnotations(documentId, note, owns)
    }

    async deleteNote(documentId: string, noteId: string): Promise<ReadingMutationResult<void>> {
        if (!isAnnotationId(noteId))
            return { ok: false, error: new ReadingStorageError("reading.storage.invalid-input") }
        const owns = this.annotationOwnership(documentId)
        if (!owns)
            return { ok: false, error: new ReadingStorageError("reading.storage.invalid-input") }
        if (
            !this.annotations(documentId).loaded &&
            !(await this.loadAnnotationsForMutation(documentId))
        )
            return { ok: false, error: new ReadingStorageError("reading.storage.read") }
        if (this.disposed || !owns())
            return { ok: false, error: new ReadingStorageError("reading.storage.write") }
        const state = freezeAnnotations(
            this.annotations(documentId).notes.filter((note) => note.id !== noteId),
            this.annotations(documentId).bookmarks,
            this.annotations(documentId).drafts,
        )
        this.publishAnnotations(documentId, state, true, true)
        return this.persistAnnotations(documentId, undefined, owns)
    }

    async createBookmark(
        documentId: string,
        input: ReadingBookmarkInput,
    ): Promise<ReadingMutationResult<ReadingBookmark>> {
        const owns = this.annotationOwnership(documentId)
        if (!owns)
            return { ok: false, error: new ReadingStorageError("reading.storage.invalid-input") }
        const bookmark = this.associateNew(
            documentId,
            readBookmark(
                { ...input, id: crypto.randomUUID(), bookId: documentId, createdAt: Date.now() },
                documentId,
            ),
        )
        if (!bookmark)
            return { ok: false, error: new ReadingStorageError("reading.storage.invalid-input") }
        if (
            !this.annotations(documentId).loaded &&
            !(await this.loadAnnotationsForMutation(documentId))
        )
            return {
                ok: false,
                error: new ReadingStorageError("reading.storage.read"),
                value: bookmark,
            }
        if (this.disposed || !owns())
            return { ok: false, error: new ReadingStorageError("reading.storage.write") }
        const current = this.annotations(documentId)
        const state = freezeAnnotations(
            current.notes,
            [...current.bookmarks, bookmark],
            current.drafts,
        )
        this.publishAnnotations(documentId, state, true, true)
        return this.persistAnnotations(documentId, bookmark, owns)
    }

    async updateBookmark(
        documentId: string,
        bookmarkId: string,
        name: string,
    ): Promise<ReadingMutationResult<ReadingBookmark>> {
        const owns = this.annotationOwnership(documentId)
        if (!owns)
            return { ok: false, error: new ReadingStorageError("reading.storage.invalid-input") }
        if (
            !this.annotations(documentId).loaded &&
            !(await this.loadAnnotationsForMutation(documentId))
        )
            return { ok: false, error: new ReadingStorageError("reading.storage.read") }
        if (this.disposed || !owns())
            return { ok: false, error: new ReadingStorageError("reading.storage.write") }
        const current = this.annotations(documentId)
        const previous = current.bookmarks.find((bookmark) => bookmark.id === bookmarkId)
        const bookmark = previous && readBookmark({ ...previous, name }, documentId)
        if (!bookmark)
            return { ok: false, error: new ReadingStorageError("reading.storage.invalid-input") }
        const state = freezeAnnotations(
            current.notes,
            current.bookmarks.map((item) => (item.id === bookmarkId ? bookmark : item)),
            current.drafts,
        )
        this.publishAnnotations(documentId, state, true, true)
        return this.persistAnnotations(documentId, bookmark, owns)
    }

    async deleteBookmark(
        documentId: string,
        bookmarkId: string,
    ): Promise<ReadingMutationResult<void>> {
        if (!isAnnotationId(bookmarkId))
            return { ok: false, error: new ReadingStorageError("reading.storage.invalid-input") }
        const owns = this.annotationOwnership(documentId)
        if (!owns)
            return { ok: false, error: new ReadingStorageError("reading.storage.invalid-input") }
        if (
            !this.annotations(documentId).loaded &&
            !(await this.loadAnnotationsForMutation(documentId))
        )
            return { ok: false, error: new ReadingStorageError("reading.storage.read") }
        if (this.disposed || !owns())
            return { ok: false, error: new ReadingStorageError("reading.storage.write") }
        const current = this.annotations(documentId)
        const state = freezeAnnotations(
            current.notes,
            current.bookmarks.filter((bookmark) => bookmark.id !== bookmarkId),
            current.drafts,
        )
        this.publishAnnotations(documentId, state, true, true)
        return this.persistAnnotations(documentId, undefined, owns)
    }

    /** Retry retained failed writes, including deletions; never reload over dirty work. */
    async saveAnnotations(documentId: string): Promise<ReadingMutationResult<void>> {
        const owns = this.annotationOwnership(documentId)
        if (!owns)
            return { ok: false, error: new ReadingStorageError("reading.storage.invalid-input") }
        if (
            !this.annotations(documentId).loaded &&
            !(await this.loadAnnotationsForMutation(documentId))
        )
            return { ok: false, error: new ReadingStorageError("reading.storage.read") }
        if (this.disposed || !owns())
            return { ok: false, error: new ReadingStorageError("reading.storage.write") }
        return this.persistAnnotations(documentId, undefined, owns)
    }

    private async persistAnnotations<T>(
        documentId: string,
        value: T,
        owns: () => boolean,
    ): Promise<ReadingMutationResult<T>> {
        let result: ReadingMutationResult<T> = {
            ok: false,
            error: new ReadingStorageError("reading.storage.write"),
            value,
        }
        this.queue = this.queue.then(async () => {
            if (!owns() || (this.recoveryReconciliation && this.pendingPromotions.has(documentId)))
                return
            // Read the authoritative cache at admission to this shared writer queue.
            // Earlier atomic draft promotions must not be undone by stale envelopes.
            const state = this.annotations(documentId)
            try {
                if (!this.storage) throw new ReadingStorageError("reading.storage.write")
                await this.storage.writeAnnotations(documentId, state)
                if (!owns()) return
                result = { ok: true, value }
                const latest = this.annotations(documentId)
                if (
                    latest.notes === state.notes &&
                    latest.bookmarks === state.bookmarks &&
                    latest.drafts === state.drafts
                )
                    this.publishAnnotations(documentId, state, true, false)
            } catch (error) {
                if (!owns()) return
                this.report(error, "reading.storage.write")
                const latest = this.annotations(documentId)
                if (
                    latest.notes === state.notes &&
                    latest.bookmarks === state.bookmarks &&
                    latest.drafts === state.drafts
                )
                    this.publishAnnotations(documentId, state, true, true, "reading.storage.write")
            }
        })
        await this.queue
        return result
    }

    private defaultState(): ReadingDocumentState {
        return Object.freeze({
            pageNumber: 1,
            scrollPosition: 0,
            scale: 1.5,
            layout: "scroll",
            ...this.options.defaults?.(),
        })
    }

    private change(
        documentId: string | null,
        state: ReadingDocumentState,
        status: ReadingSnapshot["status"],
    ): void {
        this.current = Object.freeze({ documentId, state: Object.freeze({ ...state }), status })
        if (documentId) this.states.set(documentId, this.current.state)
        this.options.onChange?.(this.current)
    }

    /** Readiness is bounded; "pending" leaves a fenced restoration running, not a successful restore. */
    async restore(storage = this.storage): Promise<"complete" | "pending"> {
        if (this.disposed || !storage) return "complete"
        this.storage = storage
        if (this.pendingPromotions.size) {
            this.recoveryReconciliation = this.reconcileRecovery()
            if (!(await this.bounded(this.recoveryReconciliation))) return "pending"
        }
        if (this.revision !== 0) {
            this.save(true)
            return "complete"
        }
        const revision = this.revision
        const restore = async () => {
            try {
                const id = await storage.readCurrent()
                if (this.disposed || revision !== this.revision || !id) return
                this.intendedId = id
                await this.select(id, true, undefined, false, revision, true)
            } catch (error) {
                this.report(error, "reading.storage.read")
            }
        }
        return (await this.bounded(restore())) ? "complete" : "pending"
    }

    open(
        id: string,
        onFailure?: (failure: ViewerOpenFailure) => void | Promise<void>,
    ): Promise<boolean> {
        if (this.disposed || !isDocumentId(id)) return Promise.resolve(false)
        this.intendedId = id
        for (const providerId of this.requiredProviders()) this.watchProvider(providerId)
        if (!this.providersAvailable()) {
            this.providerUnavailable()
            return Promise.resolve(false)
        }
        if (this.resourceController.signal.aborted) this.resourceController = new AbortController()
        return this.select(id, true, onFailure, false, ++this.revision)
    }

    setCurrentBook(book: Book | null): Promise<boolean> {
        if (!book) return this.requestClose().then((result) => result.status === "closed")
        // Library metadata is not a reading-state fallback.
        return this.open(book.id)
    }

    setPosition(pageNumber: number, scrollPosition = 0): void {
        if (!Number.isSafeInteger(pageNumber) || pageNumber < 1 || !Number.isFinite(scrollPosition))
            return
        this.update({ pageNumber, scrollPosition })
    }

    setScale(scale: number): void {
        if (!Number.isFinite(scale) || scale < 0.25 || scale > 5) return
        this.update({ scale })
    }

    setLayout(layout: ReadingLayout): void {
        if (layout !== "single" && layout !== "split" && layout !== "scroll") return
        this.update({ layout })
    }

    private update(changes: Partial<ReadingDocumentState>): void {
        if (this.disposed || !this.current.documentId) return
        const state = { ...this.current.state, ...changes }
        if (
            Object.entries(changes).every(
                ([key, value]) => this.current.state[key as keyof ReadingDocumentState] === value,
            )
        )
            return
        this.change(this.current.documentId, state, this.current.status)
        this.save(false)
    }

    private save(pointer: boolean): void {
        const storage = this.storage
        const { documentId, state } = this.current
        const knownState = !documentId || this.states.has(documentId)
        if (!storage || this.disposed || this.options.writeSignal?.aborted) return
        // Capture immutable identity/state now, never read the visible document in queued work.
        this.queue = this.queue.then(async () => {
            if (this.writesClosed || this.options.writeSignal?.aborted) return
            if (documentId && knownState) {
                try {
                    await storage.writeDocument(documentId, state)
                } catch (error) {
                    this.report(error, "reading.storage.write")
                }
            }
            if (pointer && !this.writesClosed && !this.options.writeSignal?.aborted) {
                try {
                    await storage.writeCurrent(documentId)
                } catch (error) {
                    this.report(error, "reading.storage.write")
                }
            }
        })
    }

    private report(error: unknown, fallback: ReadingStorageError["code"]): void {
        if (!this.disposed && !this.options.writeSignal?.aborted)
            this.options.onStorageError?.(
                error instanceof ReadingStorageError ? error : new ReadingStorageError(fallback),
            )
    }

    /** Bounded drain; a stuck backend stays serialized and cannot delay host writer fencing. */
    flush(): Promise<void> {
        return this.bounded(this.queue).then(() => undefined)
    }

    private async bounded(operation: Promise<unknown>): Promise<boolean> {
        let timer: ReturnType<typeof setTimeout> | undefined
        try {
            return await Promise.race([
                operation.then(() => true),
                new Promise<false>((resolve) => {
                    timer = setTimeout(() => resolve(false), 250)
                }),
            ])
        } finally {
            clearTimeout(timer)
        }
    }

    synchronize(relinked = false): Promise<void> {
        if (relinked) {
            this.resourceController.abort()
            this.resourceController = new AbortController()
        }
        this.relinkPending ||= relinked
        if (this.synchronization) return this.synchronization
        const synchronize = async () => {
            do {
                const refresh = this.relinkPending
                this.relinkPending = false
                const book = this.options.getCurrentBook()
                if (this.current.status === "provider-unavailable") return
                const id = book?.id ?? this.current.documentId
                if (!id) return
                await this.select(id, refresh, undefined, true, this.revision)
            } while (this.relinkPending)
        }
        const operation = synchronize()
        this.synchronization = operation
        void operation
            .finally(() => {
                if (this.synchronization === operation) this.synchronization = undefined
            })
            .catch(() => undefined)
        return operation
    }

    private async select(
        id: string,
        restoreAccess = false,
        onFailure?: (failure: ViewerOpenFailure) => void | Promise<void>,
        maintenance = false,
        revision = this.revision,
        restoring = false,
    ): Promise<boolean> {
        const current = () => !this.disposed && revision === this.revision
        if (!current()) return false
        if (!this.providersAvailable()) {
            this.providerUnavailable()
            return false
        }
        let state = this.states.get(id)
        if (!state && this.storage) {
            try {
                state = (await this.storage.readDocument(id)) ?? undefined
            } catch (error) {
                this.report(error, "reading.storage.read")
            }
            if (!current()) return false
        }
        state ??= this.defaultState()
        const selectedState = state
        try {
            const accepted = await this.access.select(
                id,
                (url) => {
                    if (!current()) return false
                    const node = this.options.files.nodes[id]
                    if (!node || node.type !== "file") return false
                    const latest = this.states.get(id) ?? selectedState
                    const accepted = this.options.publish({
                        ...fileNodeToBook(node),
                        pageNumber: latest.pageNumber,
                        scrollPosition: latest.scrollPosition,
                        url: url ?? "",
                        isLocked: url ? this.options.files.isLockedMap[id] : true,
                    })
                    if (accepted === false) return false
                    if (this.current.documentId && this.current.documentId !== id) {
                        this.resourceController.abort()
                        this.resourceController = new AbortController()
                    }
                    this.intendedId = id
                    this.change(id, latest, url ? "ready" : "unavailable")
                    if (!restoring) this.save(true)
                    return true
                },
                restoreAccess,
                maintenance,
            )
            if (
                !accepted &&
                current() &&
                this.options.files.nodes[id]?.type !== "file" &&
                (restoring ||
                    this.current.documentId === id ||
                    this.options.getCurrentBook()?.id === id)
            ) {
                const closing = this.access.close(false)
                this.options.publish(null)
                this.change(id, selectedState, "missing")
                await closing
            }
            return accepted
        } catch (error) {
            if (!(error instanceof DocumentAccessUnavailableError)) throw error
            if (!current()) return false
            if (
                restoring ||
                this.current.documentId === id ||
                this.options.getCurrentBook()?.id === id
            ) {
                const closing = this.access.close(false)
                const node = this.options.files.nodes[id]
                this.options.publish(
                    node
                        ? {
                              ...fileNodeToBook(node),
                              pageNumber: selectedState.pageNumber,
                              scrollPosition: selectedState.scrollPosition,
                              url: "",
                              isLocked: true,
                          }
                        : null,
                )
                this.change(
                    id,
                    this.states.get(id) ?? selectedState,
                    node ? "unavailable" : "missing",
                )
                await closing
            }
            if (restoreAccess && !restoring) {
                this.options.files.requestRelink(id)
                await onFailure?.({ bookId: id, error })
            }
            return false
        }
    }

    async retry(): Promise<boolean> {
        const id = this.intendedId
        if (!id || this.disposed) return false
        const selectionRevision = this.revision
        if (this.recoveryReconciliation) {
            if (!(await this.bounded(this.recoveryReconciliation))) return false
            if (!(await this.recoveryReconciliation)) {
                this.recoveryReconciliation = this.reconcileRecovery()
                if (
                    !(await this.bounded(this.recoveryReconciliation)) ||
                    !(await this.recoveryReconciliation)
                )
                    return false
            }
        }
        if (this.disposed || selectionRevision !== this.revision || this.intendedId !== id)
            return false
        const opening = this.open(id)
        const revision = this.revision
        this.retryRevision = revision
        const opened = await opening.finally(() => {
            if (this.retryRevision === revision) this.retryRevision = undefined
        })
        if (!opened || this.intendedId !== id || this.disposed) return false
        this.save(true)
        for (const [documentId, snapshot] of this.annotationStates) {
            if (snapshot.dirty) void this.persistDrafts(documentId)
        }
        return true
    }

    requestRelink(): void {
        if (!this.disposed && this.current.documentId)
            this.options.files.requestRelink(this.current.documentId)
    }

    async loadDocument(signal?: AbortSignal): Promise<ViewerDocument | undefined> {
        if (this.disposed || this.current.status !== "ready" || !this.current.documentId) return
        const documentId = this.current.documentId
        const controller = this.resourceController
        const contentGeneration = this.options.files.getContentGeneration(documentId)
        const owns = () =>
            !this.disposed &&
            !controller.signal.aborted &&
            this.current.documentId === documentId &&
            this.intendedId === documentId &&
            this.resourceController === controller &&
            this.options.files.isCurrentContent(documentId, contentGeneration)
        const operationSignal = signal
            ? AbortSignal.any([signal, controller.signal])
            : controller.signal
        try {
            const document = await this.access.load((claim, signal) => {
                const loader = this.options.loader
                if (!loader) throw new Error("The workspace document loader is unavailable")
                return loader.open(
                    {
                        id: claim.id,
                        url: claim.url,
                        name: this.options.files.nodes[claim.id]?.name ?? "document",
                    },
                    signal,
                )
            }, operationSignal)
            if (!document || operationSignal.aborted || !owns()) return
            const hash = "contentHash" in document ? document.contentHash : null
            this.contentIdentities.set(documentId, {
                generation: contentGeneration,
                hash: typeof hash === "string" && /^[a-f0-9]{64}$/.test(hash) ? hash : null,
            })
            if (
                document.kind === "paged" &&
                Number.isSafeInteger(document.pageCount) &&
                document.pageCount > 0 &&
                this.current.state.pageNumber > document.pageCount
            )
                this.setPosition(document.pageCount, 0)
            const records = this.annotations(documentId)
            this.publishAnnotations(
                documentId,
                records,
                records.loaded,
                records.dirty,
                records.error,
            )
            const existing = this.documentViews.get(document)
            if (existing?.controller === controller) return existing.view
            const view = new Proxy(document, {
                get: (target, key) => {
                    const value = Reflect.get(target, key, target)
                    if (typeof value !== "function" || key === "close")
                        return typeof value === "function" ? value.bind(target) : value
                    return async (...args: unknown[]) => {
                        try {
                            controller.signal.throwIfAborted()
                            if (!owns())
                                throw new DOMException("Document content superseded", "AbortError")
                            const result = await value.apply(target, args)
                            controller.signal.throwIfAborted()
                            if (!owns())
                                throw new DOMException("Document content superseded", "AbortError")
                            return result
                        } catch (error) {
                            const cancelledByCaller = args.some((argument) =>
                                argument instanceof AbortSignal
                                    ? argument.aborted
                                    : !!argument &&
                                      typeof argument === "object" &&
                                      "signal" in argument &&
                                      (argument.signal as AbortSignal | undefined)?.aborted,
                            )
                            if (owns() && !controller.signal.aborted && !cancelledByCaller)
                                this.providerUnavailable()
                            throw error
                        }
                    }
                },
            }) as ViewerDocument
            this.documentViews.set(document, { controller, view })
            return view
        } catch {
            if (owns() && !operationSignal.aborted) this.providerUnavailable()
            return undefined
        }
    }

    /** Compatibility callers cannot bypass a draft decision. UI uses requestClose/resolveClose. */
    async close(): Promise<void> {
        await this.requestClose()
    }

    async requestClose(): Promise<ReadingCloseRequest> {
        if (this.disposed) return { status: "superseded" }
        const documentId = this.current.documentId
        // An explicit close also cancels a pending initial restoration/acquisition.
        const selectionRevision =
            documentId && this.retryRevision !== this.revision ? this.revision : ++this.revision
        if (this.retryRevision !== undefined) this.intendedId = documentId
        if (documentId && this.storage && !(await this.loadDraftsForMutation(documentId)))
            return { status: "failed", error: new ReadingStorageError("reading.storage.read") }
        if (
            this.disposed ||
            selectionRevision !== this.revision ||
            this.current.documentId !== documentId
        )
            return { status: "superseded" }
        const draftRevision = documentId ? (this.draftRevisions.get(documentId) ?? 0) : 0
        if (documentId && this.annotations(documentId).drafts.length) {
            const token = Object.freeze({ documentId, selectionRevision, draftRevision })
            this.closeTokens.add(token)
            return { status: "confirmation-required", token }
        }
        if (documentId && this.annotations(documentId).dirty) {
            const saved = await this.persistDrafts(documentId)
            if (!saved.ok) return { status: "failed", error: saved.error }
        }
        return this.finishClose(documentId, selectionRevision, draftRevision)
    }

    /** One-use decision for the initiating identity, never the document visible later. */
    async resolveClose(
        token: ReadingCloseToken,
        choice: "save" | "discard" | "cancel",
    ): Promise<ReadingCloseResult> {
        if (!this.closeTokens.delete(token) || this.disposed) return { status: "superseded" }
        if (choice === "cancel") return { status: "cancelled" }
        if (choice !== "save" && choice !== "discard")
            return {
                status: "failed",
                error: new ReadingStorageError("reading.storage.invalid-input"),
            }
        const { documentId, selectionRevision, draftRevision } = token
        if ((this.draftRevisions.get(documentId) ?? 0) !== draftRevision)
            return { status: "changed" }
        const owns = this.draftOwnership(documentId)
        if (!owns)
            return { status: "failed", error: new ReadingStorageError("reading.storage.write") }
        const current = this.annotations(documentId)
        let result: ReadingMutationResult<void>
        if (choice === "save") {
            result = await this.persistDraftNotes(documentId, current.drafts, owns)
        } else {
            const state = freezeAnnotations(current.notes, current.bookmarks)
            this.publishAnnotations(documentId, state, true, true)
            result = await this.persistAnnotations(documentId, undefined, owns)
        }
        if (!result.ok) return { status: "failed", error: result.error }
        return this.finishClose(documentId, selectionRevision, draftRevision + 1)
    }

    private async finishClose(
        documentId: string | null,
        selectionRevision: number,
        draftRevision: number,
    ): Promise<ReadingCloseResult> {
        const status = (): "superseded" | "changed" | null => {
            if (
                this.disposed ||
                this.revision !== selectionRevision ||
                this.current.documentId !== documentId
            )
                return "superseded"
            if (
                documentId &&
                ((this.draftRevisions.get(documentId) ?? 0) !== draftRevision ||
                    this.annotations(documentId).drafts.length)
            )
                return "changed"
            return null
        }
        const obsolete = status()
        if (obsolete) return { status: obsolete }
        if (this.options.writeSignal?.aborted)
            return { status: "failed", error: new ReadingStorageError("reading.storage.write") }
        if (this.storage) {
            let active = true
            let persisted = false
            const storage = this.storage
            this.queue = this.queue.then(async () => {
                if (!active || status() || this.writesClosed || this.options.writeSignal?.aborted)
                    return
                try {
                    await storage.writeCurrent(null)
                    persisted = true
                    // A timed-out or superseded pointer clear must not replace newer intent.
                    if (!active || status()) this.save(true)
                } catch (error) {
                    this.report(error, "reading.storage.write")
                }
            })
            const complete = await this.bounded(this.queue)
            active = false
            const obsolete = status()
            if (obsolete) return { status: obsolete }
            if (!complete || !persisted)
                return { status: "failed", error: new ReadingStorageError("reading.storage.write") }
        }
        const obsoleteAfterWrite = status()
        if (obsoleteAfterWrite) return { status: obsoleteAfterWrite }
        if (this.options.writeSignal?.aborted || this.writesClosed)
            return { status: "failed", error: new ReadingStorageError("reading.storage.write") }
        this.intendedId = null
        this.resourceController.abort()
        const closingRevision = ++this.revision
        const closing = this.access.close()
        this.options.publish(null)
        this.change(null, this.defaultState(), "closed")
        await closing
        return {
            status: !this.disposed && this.revision === closingRevision ? "closed" : "superseded",
        }
    }

    dispose(): Promise<void> {
        if (!this.disposal) {
            this.revision++
            // Fence publication and new mutations synchronously. The host has already revoked
            // its write signal on shutdown; never revive that lifetime to finish saving.
            this.disposed = true
            this.resourceController.abort()
            this.providerSubscription?.dispose()
            for (const unsubscribe of this.providerWatches.values()) unsubscribe()
            this.providerWatches.clear()
            this.annotationListeners.clear()
            this.disposal = this.bounded(Promise.all([this.queue, this.access.dispose()]))
                .then(() => undefined)
                .finally(() => {
                    this.writesClosed = true
                })
        }
        return this.disposal
    }
}
