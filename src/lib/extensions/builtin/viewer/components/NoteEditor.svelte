<script lang="ts">
    import * as m from "$lib/paraglide/messages"
    import CloseIcon from "$lib/shared/icons/CloseIcon.svelte"
    import Button from "$lib/shared/ui/Button.svelte"
    import Modal from "$lib/shared/ui/modal/Modal.svelte"
    import { commandsStore, getShortcutHint } from "$lib/core/commands"
    import { defineCommands } from "$lib/core/commands"
    import { useModalCommands } from "$lib/core/commands"

    type NoteColor = "yellow" | "green" | "blue" | "pink" | "purple"

    let {
        editorState,
        onChange,
        onCancel,
    }: {
        editorState: {
            id?: string
            pageNumber: number
            text: string
            noteContent: string
            color: NoteColor
        }
        onChange: (change: { noteContent: string; color: NoteColor }) => void
        onCancel: () => void
    } = $props()

    let isExistingNote = $derived(editorState.id !== undefined)
    let closeLabel = $derived(isExistingNote ? m.close() : m.cancel())

    const activeNodeBeforeOpen = commandsStore.activeScope ?? commandsStore.root

    const modalCommands = defineCommands({
        "modal.cancel": {
            id: "modal.cancel",
            label: () => closeLabel,
            category: "commands",
            keymap: "escape",
            allowInInputs: true,
            dismissFocusedElement: true,
            run: () => onCancel(),
        },
        "viewer.note.save": {
            id: "viewer.note.save",
            label: () => (isExistingNote ? m.close() : m.save()),
            category: "commands",
            keymap: "ctrl+enter",
            allowInInputs: true,
            run: async (payload) => {
                await activeNodeBeforeOpen.execute("viewer.note.save", payload)
            },
        },
    })
    const editorCommandsNode = useModalCommands(
        [modalCommands["modal.cancel"], modalCommands["viewer.note.save"]],
        activeNodeBeforeOpen,
    )
</script>

{#snippet header()}
    <div class="editor-header">
        <h3 class="modal-title">{"id" in editorState ? m.edit_note() : m.add_note()}</h3>
        <div class="header-actions">
            <span class="editor-page">{m.page()} {editorState.pageNumber}</span>
            <Button
                id="note-editor-close"
                variant="close"
                square
                onclick={() => void editorCommandsNode.execute("modal.cancel")}
                aria-label={closeLabel}
                tooltip={`${closeLabel}${getShortcutHint(editorCommandsNode, "modal.cancel")}`}
            >
                <CloseIcon />
            </Button>
        </div>
    </div>
{/snippet}

<Modal
    variant="default"
    type="float"
    size="medium"
    placement="center"
    title={"id" in editorState ? m.edit_note() : m.add_note()}
    onClose={() => void editorCommandsNode.execute("modal.cancel")}
    {header}
    showCloseButton={false}
    initialFocus={() => document.getElementById("note-editor-close")}
    draggable
>
    <div class="editor-body">
        <blockquote class="editor-quote">
            "{editorState.text}"
        </blockquote>

        <textarea
            class="editor-textarea"
            placeholder={m.note_placeholder()}
            value={editorState.noteContent}
            oninput={(event) =>
                onChange({
                    noteContent: event.currentTarget.value,
                    color: editorState.color,
                })}
        ></textarea>

        <div class="color-picker">
            {#each ["yellow", "green", "blue", "pink", "purple"] as color (color)}
                {@const swatchTooltip =
                    color === "yellow"
                        ? m.select_color_yellow()
                        : color === "green"
                          ? m.select_color_green()
                          : color === "blue"
                            ? m.select_color_blue()
                            : color === "pink"
                              ? m.select_color_pink()
                              : m.select_color_purple()}
                <Button
                    variant="none"
                    class={`color-swatch swatch-${color} ${editorState.color === color ? "selected" : ""}`}
                    onclick={() =>
                        onChange({
                            noteContent: editorState.noteContent,
                            color: color as NoteColor,
                        })}
                    aria-label={swatchTooltip}
                    tooltip={swatchTooltip}
                />
            {/each}
        </div>
    </div>

    {#snippet footer()}
        <div class="modal-actions editor-actions">
            {#if !isExistingNote}
                <Button
                    variant="close"
                    class="editor-btn cancel"
                    onclick={() => void editorCommandsNode.execute("modal.cancel")}
                    aria-label={m.cancel()}
                    tooltip={`${m.cancel()}${getShortcutHint(editorCommandsNode, "modal.cancel")}`}
                >
                    {m.cancel()}
                </Button>
            {/if}
            <Button
                variant="none"
                class="editor-btn save"
                onclick={() => void editorCommandsNode.execute("viewer.note.save")}
                aria-label={isExistingNote ? m.close() : m.save()}
                tooltip={`${isExistingNote ? m.close() : m.save()}${getShortcutHint(editorCommandsNode, "viewer.note.save")}`}
            >
                {isExistingNote ? m.close() : m.save()}
            </Button>
        </div>
    {/snippet}
</Modal>

<style>
    @media (--mobile) {
        .editor-textarea {
            font-size: var(--font-size-xl) !important;
            height: 200px !important;
        }
    }

    .editor-header .modal-title {
        margin: 0;
        font-family: var(--ui-font);
        font-size: var(--font-size-2xl);
        font-weight: 700;
        line-height: 1.1;
    }

    @media (--mobile) {
        .editor-header .modal-title {
            font-size: var(--font-size-xl);
        }
    }

    .editor-body {
        min-height: 0;
        padding: 16px max(24px, var(--float-safe-area-inset-right, 0px)) 16px
            max(24px, var(--float-safe-area-inset-left, 0px));
        background: var(--bg-color);
        display: flex;
        flex-direction: column;
        gap: 8px;
    }

    @media (--mobile) {
        .editor-body {
            padding: 12px max(16px, var(--float-safe-area-inset-right, 0px)) 12px
                max(16px, var(--float-safe-area-inset-left, 0px));
        }
    }

    .editor-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        width: 100%;
        padding: 0;
        background: var(--bg-color);
        position: relative;
        z-index: var(--z-10);
    }

    .header-actions {
        display: flex;
        align-items: center;
        gap: 12px;
    }

    .editor-page {
        background: var(--muted-bg-color);
        color: var(--muted-text-color);
        padding: 4px 8px;
        font-size: var(--font-size-xs);
        font-weight: 900;
        text-transform: uppercase;
        letter-spacing: 0.5px;
    }

    .editor-quote {
        margin: 0;
        margin-bottom: 8px;
        font-style: italic;
        font-size: var(--font-size-md);
        color: var(--text-color);
        background: rgba(0, 0, 0, 0.03);
        padding: 12px 16px;
        border-left: 4px solid var(--border-color);
        max-height: 100px;
        overflow-y: auto;
        overscroll-behavior: contain;
        word-break: break-word;
        line-height: 1.4;
    }

    @media (--mobile) {
        .editor-quote {
            padding: 8px 12px;
            margin-bottom: 4px;
        }
    }

    .editor-textarea {
        width: 100%;
        height: 160px;
        font-family: inherit;
        font-size: var(--font-size-xl);
        font-weight: 600;
        padding: 16px;
        border: 2px solid var(--border-color);
        background: var(--surface-color);
        color: var(--text-color);
        resize: none;
        outline: none;
        box-sizing: border-box;
        margin-bottom: 8px;
        transition:
            background-color 0.1s ease,
            border-color 0.1s ease,
            color 0.1s ease;
    }

    @media (--mobile) {
        .editor-textarea {
            padding: 12px;
            margin-bottom: 4px;
        }
    }

    .editor-textarea:focus {
        border-color: var(--border-color);
        box-shadow: 4px 4px 0 var(--shadow-color);
    }

    .color-picker {
        display: flex;
        gap: 8px;
        justify-content: center;
        padding: 12px 0;
    }

    @media (--mobile) {
        .color-picker {
            padding: 8px 0;
            gap: 6px;
        }
    }

    :global(.color-swatch) {
        width: 28px !important;
        height: 28px !important;
        border-radius: var(--radius-full) !important;
        border: 2px solid var(--border-color) !important;
        cursor: pointer !important;
        transition: transform 0.1s ease !important;
        padding: 0 !important;
        min-height: unset !important;
        position: relative !important;
    }

    :global(.color-swatch:hover) {
        transform: scale(1.1) !important;
    }

    :global(.color-swatch.selected) {
        transform: scale(1.15) !important;
        box-shadow:
            0 0 0 2px var(--surface-color),
            0 0 0 5px var(--border-color) !important;
    }

    :global(.swatch-yellow) {
        background: #ffde4d !important;
    }
    :global(.swatch-green) {
        background: #2ecc71 !important;
    }
    :global(.swatch-blue) {
        background: #3498db !important;
    }
    :global(.swatch-pink) {
        background: #ff7675 !important;
    }
    :global(.swatch-purple) {
        background: #a78bfa !important;
    }

    .editor-actions {
        display: flex;
        justify-content: flex-end;
        gap: 12px;
    }

    @media (--mobile) {
        .editor-actions {
            gap: 8px;
        }
    }

    :global(.editor-btn) {
        padding: 8px 20px !important;
        font-family: inherit !important;
        font-size: var(--font-size-lg) !important;
        font-weight: 900 !important;
        text-transform: uppercase !important;
        cursor: pointer !important;
        border: 2px solid var(--border-color) !important;
        background: var(--surface-color) !important;
        color: var(--text-color) !important;
        box-shadow: 3px 3px 0 var(--shadow-color) !important;
        transition:
            background-color 0.1s ease,
            border-color 0.1s ease,
            color 0.1s ease !important;
        min-height: unset !important;
    }

    @media (--mobile) {
        :global(.editor-btn) {
            min-height: 44px !important;
        }
    }

    :global(.editor-btn:hover) {
        transform: translate(-1px, -1px) !important;
        box-shadow: 4px 4px 0 var(--shadow-color) !important;
        background: var(--accent-color) !important;
    }

    :global(.editor-btn:active) {
        transform: translate(1px, 1px) !important;
        box-shadow: 1px 1px 0 var(--shadow-color) !important;
    }

    :global(.editor-btn.cancel:hover) {
        background: var(--danger-color) !important;
        color: white !important;
    }
</style>
