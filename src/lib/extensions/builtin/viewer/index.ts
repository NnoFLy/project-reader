import type { Component } from "svelte"
import { KeyboardHandler } from "$lib/core/commands"
import type { CommandContribution, Disposable, ExtensionContext } from "$lib/extension-api"
import ViewerPage from "./ViewerPage.svelte"
import ViewerStatus from "./ViewerStatus.svelte"
import { createViewerOpenCommand } from "./commands/viewerOpenCommand"
import { isViewerBookmarkOpenPayload, isViewerOpenPayload } from "./commands/viewerCommandPayloads"
import { viewerStore } from "./stores/viewerStore.svelte"
import {
    installViewerHostCapabilities,
    type ViewerFileCapability,
    type ViewerLibraryCapability,
    type ViewerLibraryMutationCapability,
    type ViewerPromptCapability,
} from "./viewerHost"
import { bookmarksStore } from "./stores/bookmarksStore.svelte"
import { notesStore } from "./stores/notesStore.svelte"
import { searchStore } from "./stores/searchStore.svelte"
import { getViewerDocumentErrorDiagnostic } from "./viewerDocument"
import { installViewerRelinkHost } from "./viewerRelinkHost"
import { buildBookmarkItems } from "./commands/viewerPromptItems"
import { openViewerBookmark } from "./commands/viewerBookmarkCommandFactory"
import * as m from "$lib/paraglide/messages"

export { ViewerPage }
export { createViewerBookmarkCommands } from "./commands/viewerBookmarkCommandFactory"
export { createViewerOpenCommand } from "./commands/viewerOpenCommand"
export { bookmarksStore } from "./stores/bookmarksStore.svelte"
export { searchStore } from "./stores/searchStore.svelte"
export { viewerStore } from "./stores/viewerStore.svelte"
export { installViewerHostCapabilities } from "./viewerHost"
export type {
    ViewerFileCapability,
    ViewerLibraryCapability,
    ViewerLibraryMutationCapability,
    ViewerPromptCapability,
    ViewerSettingsCapability,
} from "./viewerHost"

export const VIEWER_VIEW_ID = "viewer.reader"

type ScrollPayload = {
    direction: "up" | "down"
    repeated: boolean
}

function scrollWindow(
    payload: ScrollPayload | undefined,
    viewportFraction: number,
    animations: boolean,
): void {
    const direction = payload?.direction === "up" ? -1 : 1
    const repeated = payload?.repeated ?? false
    window.scrollBy({
        top: direction * window.innerHeight * viewportFraction,
        behavior: !repeated && animations ? "smooth" : "auto",
    })
}

export async function activateViewer(
    context: ExtensionContext,
    fileCapability?: ViewerFileCapability,
    libraryCapability?: ViewerLibraryCapability,
    libraryMutationCapability?: ViewerLibraryMutationCapability,
    promptCapability?: ViewerPromptCapability,
    relinkHost?: Component,
): Promise<void> {
    const viewerStorage = context.storage.namespace("viewer")
    installViewerRelinkHost(relinkHost)
    installViewerHostCapabilities({
        files: fileCapability,
        library: libraryCapability,
        libraryMutations: libraryMutationCapability,
        storage: viewerStorage,
        prompt: promptCapability ?? context.host?.prompt,
        settings: context.host?.settings,
        host: context.host,
        commandExecutor: (commandId, payload) => context.commands.execute(commandId, payload),
    })
    viewerStore.reset()
    bookmarksStore.reset()
    notesStore.reset()
    searchStore.resetLifecycle()
    context.lifecycle.onDispose(() => {
        searchStore.dispose()
        notesStore.dispose()
        bookmarksStore.dispose()
        viewerStore.dispose()
        context.host?.contextualStatus?.clear()
        installViewerHostCapabilities({})
        installViewerRelinkHost(undefined)
    })
    await viewerStore.configureStorage(viewerStorage)
    await viewerStore.syncWithBooks()
    await bookmarksStore.loadAllBookmarks()
    const notificationHandles = new Set<Disposable>()
    const openCommand = createViewerOpenCommand({
        executeCommand: (commandId, payload) => context.commands.execute(commandId, payload),
        onFileAccessFailure: ({ bookId, error }) => {
            console.error("[Viewer] Unable to open document", {
                bookId,
                error: getViewerDocumentErrorDiagnostic(error),
            })
            const notification = context.notifications.error("Unable to open document")
            notificationHandles.add(notification)
        },
    })
    const executeHostCommand = (commandId: string, payload?: unknown) =>
        context.commands.execute(commandId, payload)
    const openContribution: CommandContribution = {
        id: "viewer.open",
        label: "Open book",
        keybinding: ["shift+o"],
        execute: (payload) => openCommand.run(payload as never),
        validatePayload: isViewerOpenPayload,
    }
    const openRegistration = context.commands.register(openContribution)
    const scrollRegistrations = [
        context.commands.register({
            id: "viewer.scroll.step",
            label: () => m.keymap_scroll_step(),
            keybinding: ["arrowdown", "j", "arrowup", "k"],
            preventDefault: true,
            keyboardPayload: (event) => ({
                direction:
                    KeyboardHandler.resolveDirection(event, ["arrowup", "k"], ["arrowdown", "j"]) ??
                    "down",
                repeated: event.repeat,
            }),
            execute: (payload) =>
                scrollWindow(
                    payload as ScrollPayload | undefined,
                    0.2,
                    context.host?.settings?.settingsStore.animations ?? true,
                ),
        }),
        context.commands.register({
            id: "viewer.scroll.half-page",
            label: () => m.keymap_scroll_half_page(),
            keybinding: ["pagedown", "d", "pageup", "u"],
            preventDefault: true,
            keyboardPayload: (event) => ({
                direction:
                    KeyboardHandler.resolveDirection(event, ["pageup", "u"], ["pagedown", "d"]) ??
                    "down",
                repeated: event.repeat,
            }),
            execute: (payload) =>
                scrollWindow(
                    payload as ScrollPayload | undefined,
                    0.5,
                    context.host?.settings?.settingsStore.animations ?? true,
                ),
        }),
    ]
    const bookmarkOpenRegistration = context.commands.register({
        id: "viewer.bookmark.open",
        label: "Open bookmark",
        keybinding: ["shift+b"],
        execute: async (payload) => {
            let bookmarkId = (payload as { bookmarkId?: string } | undefined)?.bookmarkId
            if (!bookmarkId) {
                const prompt = promptCapability ?? context.host?.prompt
                if (!prompt) return
                const nodes = libraryCapability?.nodes ?? {}
                bookmarkId = await prompt.promptStore.choose({
                    id: "viewer-bookmarks",
                    items: () =>
                        buildBookmarkItems(
                            bookmarksStore.bookmarks,
                            (bookId) => nodes[bookId]?.name ?? m.unknown_book(),
                        ),
                    filter: "fuzzy",
                    emptyLabel: m.no_bookmarks(),
                })
            }
            if (!bookmarkId) return
            const bookmark = bookmarksStore.bookmarks.find(({ id }) => id === bookmarkId)
            if (!bookmark) return
            await openViewerBookmark({
                open: () => executeHostCommand("viewer.open", { bookId: bookmark.bookId }),
                pageNumber: bookmark.pageNumber,
                goToPage: (pageNumber, options) => viewerStore.goToPage?.(pageNumber, options),
            })
        },
        validatePayload: isViewerBookmarkOpenPayload,
    })
    context.lifecycle.onDispose(() => {
        openRegistration.dispose()
        bookmarkOpenRegistration.dispose()
        for (const registration of scrollRegistrations) registration.dispose()
        for (const handle of notificationHandles) handle.dispose()
        notificationHandles.clear()
    })
    context.views.registerNative({
        id: VIEWER_VIEW_ID,
        slot: "viewer.toolbar",
        title: "Viewer",
        kind: "native",
        component: ViewerPage,
    })
    context.views.registerNative({
        id: "viewer.status",
        slot: "host.status",
        title: "Viewer status",
        kind: "native",
        component: ViewerStatus,
    })
}
