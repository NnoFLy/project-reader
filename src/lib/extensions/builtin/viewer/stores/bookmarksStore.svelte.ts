import { browser } from "$app/environment"
import {
    isViewerLibraryCapabilityInstalled,
    getViewerLibraryCapability,
    viewerLibraryCapability as vfsStore,
    type Bookmark,
} from "../viewerHost"

class BookmarksStore {
    private files = getViewerLibraryCapability() ?? vfsStore
    bookmarks = $state<Bookmark[]>([])
    private loadGeneration = 0
    private lifecycleEpoch = 0
    private bookWriteGenerations = new Map<string, number>()
    private bookmarkWriteGenerations = new Map<string, number>()
    private pendingDeletionBookIds = new Set<string>()
    private pendingDeletionBookmarkIds = new Set<string>()
    private disposed = false
    private readonly vfsUnsubscribers: (() => void)[] = []

    constructor() {
        this.attachLibraryListeners()
    }

    private attachLibraryListeners() {
        if (!isViewerLibraryCapabilityInstalled()) return
        this.vfsUnsubscribers.push(
            this.files.onNodesDeleting?.((bookIds) => {
                this.loadGeneration++
                for (const bookId of bookIds) {
                    this.pendingDeletionBookIds.add(bookId)
                    this.bookWriteGenerations.set(
                        bookId,
                        (this.bookWriteGenerations.get(bookId) ?? 0) + 1,
                    )
                }
            }) ?? (() => undefined),
        )
        this.vfsUnsubscribers.push(
            this.files.onNodesDeleted?.((bookIds) => this.removeByBookIds(bookIds)) ??
                (() => undefined),
        )
    }

    reset() {
        this.dispose()
        this.files = getViewerLibraryCapability() ?? vfsStore
        this.disposed = false
        this.pendingDeletionBookIds.clear()
        this.pendingDeletionBookmarkIds.clear()
        this.attachLibraryListeners()
    }

    dispose() {
        this.disposed = true
        this.lifecycleEpoch++
        this.loadGeneration++
        for (const unsubscribe of this.vfsUnsubscribers.splice(0)) unsubscribe()
        this.bookmarks = []
    }

    async loadAllBookmarks() {
        if (!browser || this.disposed || this.files.isDisposed || !this.files.initialized) return
        const generation = ++this.loadGeneration
        const lifecycleEpoch = this.lifecycleEpoch
        try {
            const loaded = (await this.files.db.bookmarks.getAll()) as Bookmark[]
            if (
                this.files.isDisposed ||
                lifecycleEpoch !== this.lifecycleEpoch ||
                generation !== this.loadGeneration ||
                !this.files.initialized
            )
                return
            const validBookIds = new Set(this.files.allFiles.map((file) => file.id))
            const stale = loaded.filter((bookmark) => !validBookIds.has(bookmark.bookId))
            if (stale.length > 0) {
                if (this.files.isDisposed || lifecycleEpoch !== this.lifecycleEpoch) return
                const cleaned = await this.files.serializeMetadataMutation(async () => {
                    if (this.files.isDisposed || lifecycleEpoch !== this.lifecycleEpoch)
                        return false
                    await this.files.db.bookmarks.bulkDelete(stale.map((bookmark) => bookmark.id))
                    return true
                })
                if (
                    !cleaned ||
                    this.files.isDisposed ||
                    lifecycleEpoch !== this.lifecycleEpoch ||
                    generation !== this.loadGeneration
                )
                    return
            }
            this.bookmarks = loaded
                .filter((bookmark) => validBookIds.has(bookmark.bookId))
                .sort((a, b) => b.createdAt - a.createdAt)
        } catch (e) {
            console.error("[BookmarksStore] Failed to load bookmarks:", e)
        }
    }

    async addBookmark(bookId: string, pageNumber: number, name: string) {
        if (!this.isWriteAllowed(bookId)) return null
        const bookmark: Bookmark = {
            id: crypto.randomUUID(),
            bookId,
            pageNumber,
            name,
            createdAt: Date.now(),
        }

        const lifecycleEpoch = this.lifecycleEpoch
        this.loadGeneration++
        const generation = this.bookWriteGenerations.get(bookId) ?? 0
        try {
            if (
                (this.bookWriteGenerations.get(bookId) ?? 0) !== generation ||
                !this.isWriteAllowed(bookId)
            )
                return null
            const written = await this.files.serializeBookMutation(bookId, async () => {
                if (!this.isWriteAllowed(bookId, bookmark.id)) return false
                await this.files.db.bookmarks.put(bookmark)
                return true
            })
            if (
                !written ||
                this.disposed ||
                lifecycleEpoch !== this.lifecycleEpoch ||
                this.pendingDeletionBookIds.has(bookId) ||
                this.pendingDeletionBookmarkIds.has(bookmark.id) ||
                (this.bookWriteGenerations.get(bookId) ?? 0) !== generation ||
                !this.bookExists(bookId) ||
                this.files.isNodeDeleting(bookId) ||
                this.files.isDisposed
            ) {
                // Store disposal/lifecycle invalidation only suppresses publication. A
                // persisted bookmark remains owned by the database until actual deletion;
                // never compensate a store-only HMR race with delete.
                return null
            }
            this.bookmarks.unshift(bookmark)
            this.bookmarks = [...this.bookmarks] // force reactivity
            return bookmark
        } catch (e) {
            console.error("[BookmarksStore] Failed to add bookmark:", e)
            return null
        } finally {
            this.loadGeneration++
        }
    }

    async updateBookmark(id: string, name: string) {
        const current = this.bookmarks.find((bookmark) => bookmark.id === id)
        if (current && this.isWriteAllowed(current.bookId, id)) {
            const updated = { ...current, name }
            const lifecycleEpoch = this.lifecycleEpoch
            this.loadGeneration++
            const generation = this.bookWriteGenerations.get(updated.bookId) ?? 0
            const bookmarkGeneration = this.bookmarkWriteGenerations.get(id) ?? 0
            try {
                if (
                    (this.bookWriteGenerations.get(updated.bookId) ?? 0) !== generation ||
                    !this.isWriteAllowed(updated.bookId, id)
                )
                    return
                const written = await this.files.serializeBookMutation(updated.bookId, async () => {
                    if (!this.isWriteAllowed(updated.bookId, id)) return false
                    await this.files.db.bookmarks.put(updated)
                    return true
                })
                if (
                    !written ||
                    this.disposed ||
                    lifecycleEpoch !== this.lifecycleEpoch ||
                    this.pendingDeletionBookIds.has(updated.bookId) ||
                    this.pendingDeletionBookmarkIds.has(id) ||
                    (this.bookWriteGenerations.get(updated.bookId) ?? 0) !== generation ||
                    (this.bookmarkWriteGenerations.get(id) ?? 0) !== bookmarkGeneration ||
                    !this.bookExists(updated.bookId) ||
                    this.files.isNodeDeleting(updated.bookId) ||
                    this.files.isDisposed
                ) {
                    // An active deletion tombstone is serialized after this write and owns
                    // cleanup. Store disposal must not delete an existing bookmark.
                    return
                }
                const index = this.bookmarks.findIndex((bookmark) => bookmark.id === id)
                if (index === -1) return
                this.bookmarks[index] = updated
                this.bookmarks = [...this.bookmarks]
            } catch (e) {
                console.error("[BookmarksStore] Failed to update bookmark:", e)
            } finally {
                this.loadGeneration++
            }
        }
    }

    private bookExists(bookId: string): boolean {
        if (
            this.pendingDeletionBookIds.has(bookId) &&
            !this.files.isNodeDeleting(bookId) &&
            this.files.nodes?.[bookId]?.type === "file"
        ) {
            this.pendingDeletionBookIds.delete(bookId)
        }
        return (
            !this.pendingDeletionBookIds.has(bookId) && this.files.nodes?.[bookId]?.type === "file"
        )
    }

    private isWriteAllowed(bookId: string, bookmarkId?: string): boolean {
        return (
            !this.disposed &&
            (bookmarkId === undefined || !this.pendingDeletionBookmarkIds.has(bookmarkId)) &&
            this.bookExists(bookId) &&
            !this.pendingDeletionBookIds.has(bookId) &&
            !this.files.isNodeDeleting(bookId) &&
            !this.files.isDisposed
        )
    }

    removeByBookIds(bookIds: Iterable<string>) {
        this.loadGeneration++
        const ids = new Set(bookIds)
        this.bookmarks = this.bookmarks.filter((bookmark) => !ids.has(bookmark.bookId))
    }

    private clearFailedBookmarkDeletion(id: string, generation: number) {
        if ((this.bookmarkWriteGenerations.get(id) ?? 0) === generation)
            this.pendingDeletionBookmarkIds.delete(id)
    }

    private async deleteUnknownBookmark(id: string): Promise<boolean> {
        const deleted = await this.files.serializeMetadataMutation(async () => {
            if (this.disposed || this.files.isDisposed) return false
            await this.files.db.bookmarks.delete(id)
            return true
        })
        return deleted === true
    }

    async deleteBookmark(id: string) {
        if (this.disposed || this.files.isDisposed) return
        const bookmark = this.bookmarks.find((candidate) => candidate.id === id)
        this.pendingDeletionBookmarkIds.add(id)
        const lifecycleEpoch = this.lifecycleEpoch
        const generation = (this.bookmarkWriteGenerations.get(id) ?? 0) + 1
        this.bookmarkWriteGenerations.set(id, generation)
        this.loadGeneration++
        let deleted = false
        try {
            deleted = !!(bookmark
                ? await this.files.serializeBookMutation(bookmark.bookId, async () => {
                      if (this.disposed || this.files.isDisposed) return false
                      await this.files.db.bookmarks.delete(id)
                      return true
                  })
                : await this.deleteUnknownBookmark(id))
            if (
                !deleted ||
                this.files.isDisposed ||
                this.disposed ||
                lifecycleEpoch !== this.lifecycleEpoch ||
                (bookmark && this.pendingDeletionBookIds.has(bookmark.bookId))
            )
                return
            this.bookmarks = this.bookmarks.filter((b) => b.id !== id)
        } catch (e) {
            console.error("[BookmarksStore] Failed to delete bookmark:", e)
        } finally {
            // Clear only this deletion's tombstone. A newer deletion generation remains
            // protected while a completed deletion does not leave the bookmark permanently
            // blocked.
            this.clearFailedBookmarkDeletion(id, generation)
            this.loadGeneration++
        }
    }
}

export const bookmarksStore = new BookmarksStore()

if (import.meta.hot) {
    import.meta.hot.dispose(() => bookmarksStore.dispose())
}
