import { createContext, type Component } from "svelte"
import { ViewerStore, installViewerStore } from "./stores/viewerStore.svelte"
import { NotesStore, installNotesStore } from "./stores/notesStore.svelte"
import { BookmarksStore, installBookmarksStore } from "./stores/bookmarksStore.svelte"
import { SearchStore, installSearchStore } from "./stores/searchStore.svelte"

export interface ViewerRuntime {
    readonly store: ViewerStore
    readonly notes: NotesStore
    readonly bookmarks: BookmarksStore
    readonly search: SearchStore
    readonly relinkHost?: Component
    readonly executeCommand: (id: string, payload?: unknown) => Promise<unknown>
}

/** Native readers and their descendants capture the owning activation, never a mutable global. */
export const [getViewerRuntimeContext, setViewerRuntimeContext] =
    createContext<() => ViewerRuntime>()

export function createViewerRuntime(
    store: ViewerStore,
    executeCommand: ViewerRuntime["executeCommand"],
    relinkHost?: Component,
): ViewerRuntime {
    const notes = new NotesStore(store.library, store.libraryMutations)
    const bookmarks = new BookmarksStore(store.library, store.libraryMutations)
    const search = new SearchStore(undefined, store, store.library, store.libraryMutations)
    return { store, notes, bookmarks, search, executeCommand, relinkHost }
}

/** Compatibility exports select the visible activation; they never own another activation's disposal. */
export function installViewerRuntime(runtime: ViewerRuntime): void {
    installViewerStore(runtime.store)
    installNotesStore(runtime.notes)
    installBookmarksStore(runtime.bookmarks)
    installSearchStore(runtime.search)
}
