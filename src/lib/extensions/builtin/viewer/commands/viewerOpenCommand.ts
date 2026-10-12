import { goto } from "$app/navigation"
import { resolve } from "$app/paths"
import { commandsStore, defineCommands } from "$lib/modules/commands"
import { vfsStore, type FileNode } from "$lib/modules/documents"
import { localizedPath } from "$lib/modules/settings"
import { viewerStore } from "../stores/viewerStore.svelte"
import type { ViewerPayload } from "./viewerCommandPayloads"
import { fileNodeToBook } from "../stores/viewerStore.types"
import * as m from "$lib/paraglide/messages"

export interface ViewerOpenFailure {
    bookId: string
    error: unknown
}

export function createViewerOpenCommand(options: {
    onFileAccessFailure: (failure: ViewerOpenFailure) => void | Promise<void>
}) {
    let openGeneration = 0
    const pendingFileUrlRefs = new Map<string, number>()

    const fileUrlKey = (id: string, url: string) => `${id}\u0000${url}`
    const trackFileUrl = (id: string, url: string) => {
        const key = fileUrlKey(id, url)
        pendingFileUrlRefs.set(key, (pendingFileUrlRefs.get(key) ?? 0) + 1)
    }
    const releaseFileUrl = (id: string, url: string, stale: boolean) => {
        const key = fileUrlKey(id, url)
        const refs = pendingFileUrlRefs.get(key)
        if (!refs) return
        if (refs > 1) pendingFileUrlRefs.set(key, refs - 1)
        else pendingFileUrlRefs.delete(key)
        // Every tracked acquisition owns one VFS lease. Releasing one lease must not be
        // skipped merely because another open currently points at the same URL. If the VFS
        // lease is already gone, only revoke an unowned URL; an active matching book may still
        // publish this exact URL after a newer same-book open reused it.
        if (stale && !vfsStore.revokeFileUrl(id, url)) {
            const activeBook = viewerStore.getCurrentBook()
            const isPublishedByActiveBook = activeBook?.id === id && activeBook.url === url
            if (!isPublishedByActiveBook && vfsStore.fileUrls[id] !== url) URL.revokeObjectURL(url)
        }
    }
    const releaseAllFileUrls = (
        leases: { id: string; url: string }[],
        keep?: { id: string; url: string },
    ) => {
        let kept = false
        for (const lease of leases) {
            if (!kept && keep && lease.id === keep.id && lease.url === keep.url) {
                releaseFileUrl(lease.id, lease.url, false)
                kept = true
            } else {
                releaseFileUrl(lease.id, lease.url, true)
            }
        }
        leases.length = 0
    }

    return defineCommands({
        "viewer.open": {
            id: "viewer.open",
            label: () => m.keymap_open_book(),
            englishLabel: () => m.keymap_open_book({}, { locale: "en" }),
            category: "navigation",
            run: async (payload: ViewerPayload<"viewer.open">) => {
                if (!payload?.bookId) {
                    await commandsStore.execute("library.book.open")
                    return
                }

                const generation = ++openGeneration
                let fileNode = vfsStore.nodes[payload.bookId] as FileNode | undefined
                if (!fileNode || fileNode.type !== "file") return

                const acquiredLeases: { id: string; url: string }[] = []
                let acquiredUrl = ""
                let reusedActiveUrl = false
                let attemptedBookUrl = ""
                while (fileNode.isLocked) {
                    try {
                        const restoredUrl = await vfsStore.restoreFileAccess(fileNode.id)
                        if (restoredUrl) {
                            acquiredUrl = restoredUrl
                            trackFileUrl(fileNode.id, restoredUrl)
                            acquiredLeases.push({ id: fileNode.id, url: restoredUrl })
                        }
                        if (generation !== openGeneration) {
                            releaseAllFileUrls(acquiredLeases)
                            return
                        }
                        fileNode = vfsStore.nodes[fileNode.id] as FileNode
                        if (!fileNode || fileNode.type !== "file") {
                            releaseAllFileUrls(acquiredLeases)
                            return
                        }
                    } catch (error) {
                        if (generation !== openGeneration) {
                            releaseAllFileUrls(acquiredLeases)
                            return
                        }
                        if (error instanceof Error && error.name === "ContentSupersededError") {
                            await vfsStore.waitForRelink(fileNode.id)
                            if (generation !== openGeneration) {
                                releaseAllFileUrls(acquiredLeases)
                                return
                            }
                            fileNode = vfsStore.nodes[fileNode.id] as FileNode
                            if (!fileNode || fileNode.type !== "file") {
                                releaseAllFileUrls(acquiredLeases)
                                return
                            }
                            continue
                        }
                        console.error("[Viewer] Failed to restore file access:", error)
                        await options.onFileAccessFailure({ bookId: payload.bookId, error })
                        releaseAllFileUrls(acquiredLeases)
                        return
                    }
                }

                try {
                    const book = fileNodeToBook(fileNode)
                    const contentGeneration = vfsStore.getContentGeneration(fileNode.id)
                    const activeBook = viewerStore.getCurrentBook()
                    const reusableUrl =
                        activeBook?.id === fileNode.id &&
                        activeBook.url &&
                        vfsStore.isCurrentFileUrl(fileNode.id, activeBook.url, contentGeneration)
                    // Reopening the active book reuses its existing lease instead of
                    // acquiring another viewer claim for the same Object URL.
                    if (reusableUrl) {
                        reusedActiveUrl = true
                        book.url = activeBook.url
                    } else if (acquiredUrl) book.url = acquiredUrl
                    if (
                        book.url &&
                        !vfsStore.isCurrentFileUrl(fileNode.id, book.url, contentGeneration)
                    ) {
                        releaseAllFileUrls(acquiredLeases)
                        return
                    }
                    if (!book.url) {
                        book.url = await vfsStore.getFileUrl(fileNode.id)
                        if (book.url) {
                            acquiredUrl = book.url
                            trackFileUrl(fileNode.id, book.url)
                            acquiredLeases.push({ id: fileNode.id, url: book.url })
                        }
                    }
                    if (
                        generation !== openGeneration ||
                        !vfsStore.isCurrentContent(fileNode.id, contentGeneration)
                    ) {
                        releaseAllFileUrls(acquiredLeases)
                        return
                    }
                    if (!book.url) {
                        await options.onFileAccessFailure({
                            bookId: payload.bookId,
                            error: new Error("File access is unavailable"),
                        })
                        releaseAllFileUrls(acquiredLeases)
                        return
                    }
                    if (!vfsStore.isCurrentFileUrl(fileNode.id, book.url, contentGeneration)) {
                        releaseAllFileUrls(acquiredLeases)
                        return
                    }
                    attemptedBookUrl = book.url
                    const accepted = await viewerStore.setCurrentBook(book)
                    if (accepted === false) {
                        releaseAllFileUrls(acquiredLeases)
                        return
                    }
                    // Accepted publication is the ownership-transfer point. Transfer the
                    // published lease before observing a newer open: that newer operation may
                    // reuse this exact active URL, and the older operation must not release it
                    // merely because its command generation is stale afterward.
                    releaseAllFileUrls(
                        acquiredLeases,
                        reusedActiveUrl ? undefined : { id: fileNode.id, url: book.url },
                    )
                    if (generation !== openGeneration) return
                } catch (error) {
                    releaseAllFileUrls(acquiredLeases)
                    if (generation !== openGeneration) return
                    console.error("[Viewer] Unexpected book open failure:", error)
                    const publishedBook = viewerStore.getCurrentBook()
                    const publishedBookMatchesAttempt =
                        publishedBook?.id === payload.bookId &&
                        publishedBook?.url === attemptedBookUrl
                    if (!publishedBookMatchesAttempt) {
                        try {
                            await viewerStore.setCurrentBook(null)
                        } catch (cleanupError) {
                            console.error(
                                "[Viewer] Failed to clear the rejected book:",
                                cleanupError,
                            )
                        }
                    }
                    throw error
                }

                vfsStore.clearForwardHistory()
                await goto(resolve(localizedPath("/viewer") as any))
            },
        },
    })["viewer.open"]
}
