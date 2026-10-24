import type { ReadingWorkspace } from "../readingWorkspace"
import type { ReadingBookmark as Bookmark } from "../readingAnnotations"
import { getViewerLibraryCapability, type ViewerLibraryCapability } from "../viewerHost"

/** Presentation adapter; persistence and mutation fencing belong to the owning workspace. */
export class BookmarksStore {
    bookmarks = $state<Bookmark[]>([])
    failed = $state(false)
    private disposed = false
    private readonly failedDeletions = new Map<string, string>()
    private readonly unsubscribe: () => void
    private readonly stopDeletion: () => void

    constructor(
        private readonly workspace?: ReadingWorkspace,
        private readonly files: ViewerLibraryCapability | undefined = getViewerLibraryCapability(),
    ) {
        this.unsubscribe =
            workspace?.subscribeAnnotations(() => this.refresh()) ?? (() => undefined)
        this.stopDeletion =
            files?.onNodesDeleted?.((ids) => this.removeByBookIds(ids)) ?? (() => undefined)
    }

    private refresh(): void {
        if (this.disposed || !this.workspace || !this.files) return
        this.bookmarks = this.files.allFiles
            .flatMap((file) => [...this.workspace!.anchoredAnnotations(file.id).bookmarks])
            .sort((a, b) => b.createdAt - a.createdAt)
        this.failed = this.files.allFiles.some(
            (file) => this.workspace!.annotations(file.id).error !== null,
        )
    }

    async loadAllBookmarks(): Promise<void> {
        if (this.disposed || !this.workspace || !this.files?.initialized) return
        await Promise.all(
            this.files.allFiles.map((file) => this.workspace!.loadAnnotations(file.id)),
        )
        this.refresh()
    }

    async saveBookmark(bookId: string, pageNumber: number, name: string, bookmarkId?: string) {
        if (this.disposed || !this.workspace) return null
        const result = bookmarkId
            ? await this.workspace.updateBookmark(bookId, bookmarkId, name)
            : await this.workspace.createBookmark(bookId, {
                  pageNumber,
                  name,
                  association: { contentHash: null, verification: "unverified" },
              })
        if (!this.disposed) this.failed = !result.ok
        return result
    }

    async addBookmark(bookId: string, pageNumber: number, name: string) {
        const result = await this.saveBookmark(bookId, pageNumber, name)
        return result?.ok ? result.value : null
    }

    async updateBookmark(id: string, name: string): Promise<boolean> {
        const bookmark = this.bookmarks.find((bookmark) => bookmark.id === id)
        if (this.disposed || !this.workspace || !bookmark) return false
        const result = await this.workspace.updateBookmark(bookmark.bookId, id, name)
        this.failed = !result.ok
        return result.ok
    }

    async deleteBookmark(id: string): Promise<boolean> {
        const bookmark = this.bookmarks.find((bookmark) => bookmark.id === id)
        const documentId = bookmark?.bookId ?? this.failedDeletions.get(id)
        if (this.disposed || !this.workspace || !documentId) return false
        const result = bookmark
            ? await this.workspace.deleteBookmark(documentId, id)
            : await this.workspace.saveAnnotations(documentId)
        if (this.disposed) return false
        this.failed = !result.ok
        if (result.ok) this.failedDeletions.delete(id)
        else this.failedDeletions.set(id, documentId)
        return result.ok
    }

    removeByBookIds(bookIds: Iterable<string>): void {
        const ids = new Set(bookIds)
        this.bookmarks = this.bookmarks.filter((bookmark) => !ids.has(bookmark.bookId))
    }

    reset(): void {
        this.bookmarks = []
    }

    dispose(): void {
        this.disposed = true
        this.unsubscribe()
        this.stopDeletion()
        this.bookmarks = []
    }
}

export let bookmarksStore = new BookmarksStore()
export function installBookmarksStore(store: BookmarksStore): void {
    bookmarksStore = store
}
if (import.meta.hot) import.meta.hot.dispose(() => bookmarksStore.dispose())
