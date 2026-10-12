import { commandsStore } from "$lib/extensions/builtin/library/commands/commandsStore.svelte"
import type { CommandExecutionResult } from "$lib/extensions/builtin/library/commands/commands.types"
import type {
    ViewerBookmarkAddPayload,
    ViewerBookmarkDeletePayload,
    ViewerBookmarkEditPayload,
    ViewerNoteDeletePayload,
    ViewerNoteEditPayload,
} from "./viewerCommandPayloads"

export function executeViewerBookmarkAdd(
    payload: ViewerBookmarkAddPayload,
): Promise<CommandExecutionResult> {
    return commandsStore.execute("viewer.bookmark.add", payload)
}

export function executeViewerBookmarkEdit(
    payload: ViewerBookmarkEditPayload,
): Promise<CommandExecutionResult> {
    return commandsStore.execute("viewer.bookmark.edit", payload)
}

export function executeViewerBookmarkDelete(
    payload: ViewerBookmarkDeletePayload,
): Promise<CommandExecutionResult> {
    return commandsStore.execute("viewer.bookmark.delete", payload)
}

export function executeViewerNoteEdit(
    payload: ViewerNoteEditPayload,
): Promise<CommandExecutionResult> {
    return commandsStore.execute("viewer.note.edit", payload)
}

export function executeViewerNoteDelete(
    payload: ViewerNoteDeletePayload,
): Promise<CommandExecutionResult> {
    return commandsStore.execute("viewer.note.delete", payload)
}
