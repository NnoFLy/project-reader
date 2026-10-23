import { goto } from "$app/navigation"
import { resolve } from "$app/paths"
import { localizedPath } from "$lib/core/settings"
import type { ViewerStore } from "./stores/viewerStore.svelte"
import type { ReadingCloseRequest, ReadingCloseToken } from "./readingWorkspace"

/** Explicit close decisions belong to the reader, never to resource cleanup. */
export class ViewerCloseController {
    token = $state.raw<ReadingCloseToken | null>(null)
    busy = $state(false)
    failed = $state(false)
    private request = 0
    private navigation: Promise<void> | undefined

    constructor(private readonly store: ViewerStore) {}

    /** Supersede even an already-started Library navigation before acquiring a new source. */
    selectionStarted(): void {
        this.request++
        this.token = null
        this.failed = false
        this.busy = false
        if (this.navigation) {
            const previous = this.navigation
            const replacement = goto(resolve(localizedPath("/viewer") as "/viewer")).catch(
                () => undefined,
            )
            // The new selection's final route waits for both navigations, so a delayed
            // old route completion cannot replace the newly selected reader.
            const navigation = Promise.allSettled([previous, replacement]).then(() => undefined)
            this.navigation = navigation
            void navigation.then(() => {
                if (this.navigation === navigation) this.navigation = undefined
            })
        }
    }

    async settleNavigation(): Promise<void> {
        await this.navigation
    }

    async close(): Promise<void> {
        if (this.busy) return
        const request = ++this.request
        const documentId = this.store.workspace.snapshot.documentId
        this.busy = true
        this.failed = false
        await this.present(await this.store.workspace.requestClose(), request, documentId)
    }

    async choose(choice: "save" | "discard" | "cancel"): Promise<void> {
        const token = this.token
        if (!token || this.busy) return
        const request = this.request
        this.busy = true
        const result = await this.store.workspace.resolveClose(token, choice)
        await this.present(result, request, token.documentId)
    }

    private async present(
        result: ReadingCloseRequest,
        request: number,
        documentId: string | null,
    ): Promise<void> {
        if (request !== this.request) return
        this.token = null
        if (result.status === "confirmation-required") {
            this.token = result.token
        } else if (result.status === "closed") {
            const revision = this.store.workspace.selectionRevision
            const node = documentId ? this.store.library.nodes[documentId] : undefined
            const folder = node?.parentId ? this.store.library.getFolderPath(node.parentId) : ""
            const path =
                localizedPath("/") + (folder ? `?folder=${encodeURIComponent(folder)}` : "")
            if (documentId) this.store.libraryMutations.pushForwardHistory(documentId)
            if (request === this.request && this.store.workspace.selectionRevision === revision) {
                const navigation = goto(resolve(path as "/")).catch(() => undefined)
                this.navigation = navigation
                await navigation
                if (this.navigation === navigation) this.navigation = undefined
            }
        } else if (result.status === "changed" || result.status === "failed") {
            this.failed = result.status === "failed"
            // Tokens are one-use, including failed saves and edits during a decision.
            // requestClose also retries a previously explicit discard's tombstone.
            if (this.store.workspace.snapshot.documentId === documentId) {
                const fresh = await this.store.workspace.requestClose()
                if (request !== this.request) return
                if (fresh.status === "confirmation-required") this.token = fresh.token
                else if (fresh.status === "closed") {
                    await this.present(fresh, request, documentId)
                    return
                }
            }
        }
        if (request === this.request) this.busy = false
    }
}
