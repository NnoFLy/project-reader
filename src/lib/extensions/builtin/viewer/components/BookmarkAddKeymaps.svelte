<script lang="ts">
    import { commandsStore, type CommandScope } from "$lib/modules/commands"
    import { useModalCommands } from "$lib/modules/commands"
    import { createViewerMutationCommands } from "../commands/viewerMutationCommands"
    import { defineCommands } from "$lib/modules/commands"
    import type { ViewerBookmarkAddPayload } from "../commands/viewerCommandPayloads"
    import * as m from "$lib/paraglide/messages"

    type BookmarkAddPayload = ViewerBookmarkAddPayload
    let {
        onConfirm,
        onCancel,
        getPayload,
        scope = $bindable(),
    } = $props<{
        onConfirm: (payload: BookmarkAddPayload) => void | Promise<void>
        onCancel: () => void
        getPayload: () => BookmarkAddPayload
        scope?: CommandScope
    }>()

    const activeNodeBeforeOpen = commandsStore.activeScope

    const cancelCommand = defineCommands({
        "modal.cancel": {
            id: "modal.cancel",
            label: () => m.cancel_bookmark_add(),
            englishLabel: () => m.cancel_bookmark_add({}, { locale: "en" }),
            category: "commands",
            keymap: ["escape", "ctrl+c", "ctrl+["],
            allowInInputs: true,
            dismissFocusedElement: true,
            run: () => onCancel(),
        },
    })["modal.cancel"]

    const mutationCommands = createViewerMutationCommands({
        addBookmark: (payload) => onConfirm(payload ?? getPayload()),
        editBookmark: () => {},
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
                ...mutationCommands["viewer.bookmark.add"]!,
                keymap: "ctrl+enter",
                preventDefault: true,
                allowInInputs: true,
                keyboardPayload: () => getPayload(),
            },
        ],
        activeNodeBeforeOpen,
    )
</script>
