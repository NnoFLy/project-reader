import { goto } from "$app/navigation"
import { resolve } from "$app/paths"
import { defineCommands } from "$lib/core/commands"
import { viewerFileCapability } from "../viewerHost"
import { localizedPath } from "$lib/core/settings"
import { viewerStore } from "../stores/viewerStore.svelte"
import type { ViewerPayload } from "./viewerCommandPayloads"
import * as m from "$lib/paraglide/messages"
import type { ReadingWorkspace, ViewerOpenFailure } from "../readingWorkspace"

export type { ViewerOpenFailure } from "../readingWorkspace"

export function createViewerOpenCommand(options: {
    onFileAccessFailure: (failure: ViewerOpenFailure) => void | Promise<void>
    executeCommand?: (commandId: string, payload?: unknown) => Promise<unknown>
    workspace?: ReadingWorkspace
    clearForwardHistory?: () => void
    selectionStarted?: () => void
    settleCloseNavigation?: () => Promise<void>
}) {
    const workspace = options.workspace ?? viewerStore.workspace
    return defineCommands({
        "viewer.open": {
            id: "viewer.open",
            label: () => m.keymap_open_book(),
            englishLabel: () => m.keymap_open_book({}, { locale: "en" }),
            category: "navigation",
            run: async (payload: ViewerPayload<"viewer.open">) => {
                if (!payload?.bookId) {
                    await options.executeCommand?.("library.book.open")
                    return
                }
                options.selectionStarted?.()
                const opening = workspace.open(payload.bookId, options.onFileAccessFailure)
                const revision = workspace.selectionRevision
                if (!(await opening)) return
                await options.settleCloseNavigation?.()
                if (workspace.selectionRevision !== revision) return
                ;(
                    options.clearForwardHistory ??
                    (() => viewerFileCapability.clearForwardHistory())
                )()
                await goto(resolve(localizedPath("/viewer") as "/viewer"))
            },
        },
    })["viewer.open"]
}
