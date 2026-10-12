<script lang="ts">
    import { commandsStore, type CommandScope } from "$lib/modules/commands"
    import { useModalCommands } from "$lib/modules/commands"
    import { createViewerMutationCommands } from "../commands/viewerMutationCommands"
    import { defineCommands } from "$lib/modules/commands"
    import type { ViewerBookmarkEditPayload } from "../commands/viewerCommandPayloads"
    import * as m from "$lib/paraglide/messages"

    type BookmarkEditPayload = ViewerBookmarkEditPayload
    let {
        onConfirm,
        onCancel,
        getPayload,
        scope = $bindable(),
    } = $props<{
        onConfirm: (payload: BookmarkEditPayload) => void | Promise<void>
        onCancel: () => void
        getPayload: () => BookmarkEditPayload
        scope?: CommandScope
    }>()

    const activeNodeBeforeOpen = commandsStore.activeScope

    const cancelCommand = defineCommands({
        "modal.cancel": {
            id: "modal.cancel",
            // Use the descriptive action in keyboard help rather than a generic cancel label.
            label: () => m.cancel_bookmark_edit(),
            englishLabel: () => m.cancel_bookmark_edit({}, { locale: "en" }),
            category: "commands",
            keymap: ["escape", "ctrl+c", "ctrl+["],
            allowInInputs: true,
            dismissFocusedElement: true,
            run: () => onCancel(),
        },
    })["modal.cancel"]

    const mutationCommands = createViewerMutationCommands({
        addBookmark: () => {},
        editBookmark: (payload) => onConfirm(payload ?? getPayload()),
        deleteBookmark: () => {},
        addNote: () => {},
        editNote: () => {},
        saveNote: () => {},
        deleteNote: () => {},
    })

    scope = useModalCommands(
        [
            cancelCommand,
            {
                ...mutationCommands["viewer.bookmark.edit"]!,
                keymap: "ctrl+enter",
                preventDefault: true,
                allowInInputs: true,
                keyboardPayload: () => getPayload(),
            },
        ],
        activeNodeBeforeOpen,
    )
</script>
