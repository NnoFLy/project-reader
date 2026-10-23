import type { ProviderAvailability } from "$lib/extension-api/providers"
import type { ReadingRecoveryRecord } from "./readingWorkspace"

import type { Component } from "svelte"
import { KeyboardHandler } from "$lib/core/commands"
import type { CommandContribution, Disposable, ExtensionContext } from "$lib/extension-api"
import ViewerPage from "./ViewerPage.svelte"
import ViewerStatus from "./ViewerStatus.svelte"
import { createViewerOpenCommand } from "./commands/viewerOpenCommand"
import { isViewerBookmarkOpenPayload, isViewerOpenPayload } from "./commands/viewerCommandPayloads"
import { ViewerStore, viewerStore } from "./stores/viewerStore.svelte"
import { createViewerRuntime, installViewerRuntime, setViewerRuntimeContext } from "./viewerRuntime"
import {
    installViewerHostCapabilities,
    type ViewerFileCapability,
    type ViewerLibraryCapability,
    type ViewerLibraryMutationCapability,
    type ViewerPromptCapability,
} from "./viewerHost"
import type { ViewerDocumentLoader } from "./viewerDocument"
import { buildBookmarkItems } from "./commands/viewerPromptItems"
import { openViewerBookmark } from "./commands/viewerBookmarkCommandFactory"
import * as m from "$lib/paraglide/messages"
import { createKeyboardScroller } from "./utils/keyboardScroll"

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

const recoveryHandoffs = new WeakMap<ProviderAvailability, ReadingRecoveryRecord>()

export const VIEWER_VIEW_ID = "viewer.reader"

type ScrollPayload = {
    direction: "up" | "down"
    repeated: boolean
}

function scrollWindow(
    payload: ScrollPayload | undefined,
    viewportFraction: number,
    animations: boolean,
    scroller: ReturnType<typeof createKeyboardScroller>,
): void {
    const container = document.scrollingElement
    if (!(container instanceof HTMLElement)) return
    const direction = payload?.direction === "up" ? -1 : 1
    const repeated = payload?.repeated ?? false
    scroller.scrollBy(
        container,
        direction * window.innerHeight * viewportFraction,
        !repeated && animations,
    )
}

export async function activateViewer(
    context: ExtensionContext,
    fileCapability?: ViewerFileCapability,
    libraryCapability?: ViewerLibraryCapability,
    libraryMutationCapability?: ViewerLibraryMutationCapability,
    promptCapability?: ViewerPromptCapability,
    relinkHost?: Component,
    loader?: ViewerDocumentLoader,
): Promise<void> {
    const viewerStorage = context.storage.namespace("viewer")
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
    const providers = context.host?.providers
    const recovery = providers && recoveryHandoffs.get(providers)
    if (providers) recoveryHandoffs.delete(providers)
    const signals = [context.host?.writeSignal, context.lifecycle.signal].filter(
        (signal): signal is AbortSignal => !!signal,
    )
    const writeSignal = signals.length ? AbortSignal.any(signals) : undefined
    const notificationHandles = new Set<Disposable>()
    const store = new ViewerStore({
        files: fileCapability,
        library: libraryCapability,
        mutations: libraryMutationCapability,
        loader,
        writeSignal,
        providers,
        recovery,
        defaults: () => ({
            scale: context.host?.settings?.settingsStore.scale ?? 1.5,
            layout: context.host?.settings?.settingsStore.layout ?? "scroll",
        }),
        onStorageError: (error) => {
            const notification = context.notifications.error(
                `[Viewer:${error.code}] ${error.message}`,
            )
            notificationHandles.add(notification)
        },
    })
    const revoke = () => {
        const record = store.workspace.captureRecovery()
        if (providers && record) recoveryHandoffs.set(providers, record)
        void store.dispose()
    }
    context.lifecycle.signal?.addEventListener("abort", revoke, { once: true })
    context.lifecycle.onDispose(() => {
        context.lifecycle.signal?.removeEventListener("abort", revoke)
        return store.dispose()
    })
    // Annotation controls are registered only after persistence has been configured.
    await store.configureStorage(viewerStorage)
    if (context.lifecycle.isDisposed()) return
    const readingSummaries = { getSummary: (id: string) => store.workspace.getReadingSummary(id) }
    if (context.host) context.host.readingSummaries = readingSummaries
    const readingDisplay = {
        get active() {
            return store.workspace.snapshot.documentId !== null
        },
        get scale() {
            return store.scale
        },
        set scale(value: number) {
            store.scale = value
        },
        get layout() {
            return store.layout
        },
        set layout(value: typeof store.layout) {
            store.layout = value
        },
    }
    if (context.host) context.host.readingDisplay = readingDisplay
    const readingRecovery = {
        get documentId() {
            return store.reading.documentId
        },
        get status() {
            return store.reading.status
        },
        retry: () => store.workspace.retry(),
    }
    if (context.host) context.host.readingRecovery = readingRecovery
    const runtime = createViewerRuntime(
        store,
        (id, payload) => context.commands.execute(id, payload),
        relinkHost,
        writeSignal,
        context.host?.settings,
    )
    const { notes: notesStore, bookmarks: bookmarksStore, search: searchStore } = runtime
    installViewerRuntime(runtime)
    context.lifecycle.onDispose(async () => {
        searchStore.dispose()
        notesStore.dispose()
        bookmarksStore.dispose()
        if (viewerStore === store) {
            installViewerHostCapabilities({})
        }
        if (context.host?.readingSummaries === readingSummaries)
            context.host.readingSummaries = undefined
        if (context.host?.readingDisplay === readingDisplay) context.host.readingDisplay = undefined
        if (context.host?.readingRecovery === readingRecovery)
            context.host.readingRecovery = undefined
        context.host?.contextualStatus?.clear()
        await store.dispose()
    })
    await store.syncWithBooks()
    await bookmarksStore.loadAllBookmarks()
    const openCommand = createViewerOpenCommand({
        workspace: store.workspace,
        selectionStarted: () => runtime.closing.selectionStarted(),
        settleCloseNavigation: () => runtime.closing.settleNavigation(),
        clearForwardHistory: () => fileCapability?.clearForwardHistory(),
        executeCommand: (commandId, payload) => context.commands.execute(commandId, payload),
        onFileAccessFailure: () => {
            const notification = context.notifications.error(
                "[Viewer:reading.access.unavailable] Unable to open document",
            )
            notificationHandles.add(notification)
        },
    })
    const executeHostCommand = (commandId: string, payload?: unknown) =>
        context.commands.execute(commandId, payload)
    const openContribution: CommandContribution = {
        id: "viewer.open",
        label: openCommand.label,
        englishLabel: openCommand.englishLabel,
        keybinding: ["shift+o"],
        execute: (payload) => openCommand.run(payload as never),
        validatePayload: isViewerOpenPayload,
    }
    const openRegistration = context.commands.register(openContribution)
    const keyboardScroller = createKeyboardScroller()
    const scrollRegistrations = [
        context.commands.register({
            id: "viewer.scroll.step",
            label: m.keymap_scroll_step,
            englishLabel: () => m.keymap_scroll_step({}, { locale: "en" }),
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
                    keyboardScroller,
                ),
        }),
        context.commands.register({
            id: "viewer.scroll.half-page",
            label: m.keymap_scroll_half_page,
            englishLabel: () => m.keymap_scroll_half_page({}, { locale: "en" }),
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
                    keyboardScroller,
                ),
        }),
    ]
    const bookmarkOpenRegistration = context.commands.register({
        id: "viewer.bookmark.open",
        label: m.open_bookmark,
        englishLabel: () => m.open_bookmark({}, { locale: "en" }),
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
                goToPage: (pageNumber, options) => {
                    if (store.workspace.snapshot.documentId === bookmark.bookId)
                        store.goToPage(pageNumber, options)
                },
            })
        },
        validatePayload: isViewerBookmarkOpenPayload,
    })
    context.lifecycle.onDispose(() => {
        openRegistration.dispose()
        bookmarkOpenRegistration.dispose()
        keyboardScroller.cancel()
        for (const registration of scrollRegistrations) registration.dispose()
        for (const handle of notificationHandles) handle.dispose()
        notificationHandles.clear()
    })
    context.views.registerNative({
        id: VIEWER_VIEW_ID,
        slot: "viewer.toolbar",
        title: "Viewer",
        kind: "native",
        component: ((anchor, props) =>
            ViewerPage(anchor, { ...props, runtime })) satisfies typeof ViewerPage,
    })
    context.views.registerNative({
        id: "viewer.status",
        slot: "host.status",
        title: "Viewer status",
        kind: "native",
        component: ((anchor, props) => {
            setViewerRuntimeContext(() => runtime)
            return ViewerStatus(anchor, props)
        }) satisfies typeof ViewerStatus,
    })
}
