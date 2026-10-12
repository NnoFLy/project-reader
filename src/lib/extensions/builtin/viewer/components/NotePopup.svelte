<script lang="ts">
    import * as m from "$lib/paraglide/messages"
    import Button from "$lib/shared/ui/Button.svelte"
    import Modal from "$lib/shared/ui/modal/Modal.svelte"
    import { commandsStore, getShortcutHint } from "$lib/core/commands"
    import { defineCommands } from "$lib/core/commands"
    import { useModalCommands } from "$lib/core/commands"
    import { createViewerMutationCommands } from "../commands/viewerMutationCommands"
    import type { UserNote } from "$lib/core/documents"

    let {
        activePopup,
        onClose,
        onEdit,
        onDelete,
    }: {
        activePopup: { x: number; y: number; note: UserNote }
        onClose: () => void
        onEdit: () => void
        onDelete: () => void
    } = $props()

    const activeNodeBeforeOpen = commandsStore.activeScope

    const modalCommands = defineCommands({
        "modal.cancel": {
            id: "modal.cancel",
            label: () => m.close(),
            category: "commands",
            keymap: ["escape", "q"],
            allowInInputs: true,
            dismissFocusedElement: true,
            run: () => onClose(),
        },
    })
    const mutationCommands = createViewerMutationCommands({
        addBookmark: () => {},
        editBookmark: () => {},
        deleteBookmark: () => {},
        addNote: () => {},
        editNote: () => onEdit(),
        saveNote: () => {},
        deleteNote: () => onDelete(),
    })

    const popupCommandsNode = useModalCommands(
        [
            modalCommands["modal.cancel"],
            { ...mutationCommands["viewer.note.edit"]!, keymap: "e" },
            { ...mutationCommands["viewer.note.delete"]!, keymap: "d" },
        ],
        activeNodeBeforeOpen,
    )

    function handleCopyOrClose(event: KeyboardEvent) {
        if (!event.ctrlKey || (event.key !== "c" && event.key !== "[")) return
        event.stopPropagation()
        if (event.key === "c" && window.getSelection()?.toString()) return
        event.preventDefault()
        void popupCommandsNode.execute("modal.cancel")
    }
</script>

<svelte:window onkeydowncapture={handleCopyOrClose} />

<Modal
    variant="default"
    type="float"
    size="small"
    placement="center"
    title={m.edit_note()}
    closeLabel={m.close()}
    draggable
    onClose={() => void popupCommandsNode.execute("modal.cancel")}
    initialFocus="first"
>
    {#snippet header()}
        <span class="popup-page">{m.page()} {activePopup.note.pageNumber}</span>
    {/snippet}

    <div class="note-popup-content">
        <blockquote class="popup-quote">
            "{activePopup.note.text}"
        </blockquote>

        {#if activePopup.note.noteContent}
            <div class="popup-content">
                {activePopup.note.noteContent}
            </div>
        {/if}
    </div>

    {#snippet footer()}
        <div class="modal-actions popup-footer">
            <Button
                variant="none"
                class="popup-btn edit"
                onclick={() =>
                    void popupCommandsNode.execute("viewer.note.edit", {
                        noteId: activePopup.note.id,
                        x: activePopup.x,
                        y: activePopup.y,
                    })}
                aria-label={m.edit_note()}
                tooltip={`${m.edit_note()}${getShortcutHint(popupCommandsNode, "viewer.note.edit")}`}
            >
                {m.edit_note()}
            </Button>
            <Button
                variant="none"
                class="popup-btn delete"
                onclick={() =>
                    void popupCommandsNode.execute("viewer.note.delete", {
                        noteId: activePopup.note.id,
                    })}
                aria-label={m.delete()}
                tooltip={`${m.delete()}${getShortcutHint(popupCommandsNode, "viewer.note.delete")}`}
            >
                {m.delete()}
            </Button>
        </div>
    {/snippet}
</Modal>

<style>
    .note-popup-content {
        box-sizing: border-box;
        padding: 12px max(24px, var(--float-safe-area-inset-right, 0px)) 12px
            max(24px, var(--float-safe-area-inset-left, 0px));
        display: flex;
        flex-direction: column;
        gap: 8px;
        width: 100%;
    }

    .popup-page {
        display: inline-block;
        font-size: var(--font-size-base);
        font-weight: 900;
        background: var(--muted-bg-color);
        color: var(--muted-text-color);
        border: 1px solid var(--border-color);
        padding: 2px 6px;
        border-radius: var(--radius-sm);
    }

    .popup-quote {
        margin: 0;
        font-style: italic;
        font-size: var(--font-size-lg);
        overflow-y: auto;
        color: var(--text-color);
        background: rgba(0, 0, 0, 0.04);
        padding: 6px;
        border-left: 3px solid var(--border-color);
        max-height: 240px;
        word-break: break-word;
    }

    .popup-content {
        font-size: var(--font-size-xl);
        font-weight: 700;
        color: var(--text-color);
        line-height: 1.4;
        word-break: break-word;
        flex: 0 0 auto;
    }

    .popup-footer {
        display: flex;
        justify-content: flex-end;
        gap: 8px;
    }

    :global(.popup-btn) {
        padding: 4px 8px !important;
        font-family: inherit !important;
        font-size: var(--font-size-xs) !important;
        font-weight: 900 !important;
        text-transform: uppercase !important;
        cursor: pointer !important;
        border: 2px solid var(--border-color) !important;
        background: var(--surface-color) !important;
        color: var(--text-color) !important;
        box-shadow: 2px 2px 0 var(--shadow-color) !important;
        transition:
            background-color 0.1s ease,
            border-color 0.1s ease,
            color 0.1s ease !important;
        min-height: unset !important;
    }

    @media (--mobile) {
        :global(.popup-btn) {
            min-height: 44px !important;
        }
    }

    :global(.popup-btn:hover) {
        transform: translate(-1px, -1px) !important;
        box-shadow: 3px 3px 0 var(--shadow-color) !important;
        background: var(--accent-color) !important;
    }

    :global(.popup-btn.delete:hover) {
        color: #e53935 !important;
        background: rgba(229, 57, 53, 0.1) !important;
    }
</style>
