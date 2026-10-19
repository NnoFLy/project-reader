<script lang="ts">
    import { viewport } from "$lib/shared/state/viewport.svelte"
    import * as m from "$lib/paraglide/messages"
    import { SidebarFooter, SidebarSearch } from "$lib/shared/ui/sidebar"
    import { useCommands, KeyboardHandler, commandsStore } from "$lib/core/commands"
    import { MediaQuery } from "svelte/reactivity"
    import { modalManager } from "$lib/shared/ui/modal/modalManager.svelte"
    import { resolveSelectionIndex } from "$lib/shared/state/listSelection"
    import { notesStore } from "../stores/notesStore.svelte"
    import TrashIcon from "$lib/shared/icons/TrashIcon.svelte"
    import EditIcon from "$lib/shared/icons/EditIcon.svelte"
    import type { UserNote } from "$lib/core/documents"
    import {
        executeViewerNoteDelete,
        executeViewerNoteEdit,
    } from "../commands/viewerMutationExecution"
    import { createViewerMutationCommands } from "../commands/viewerMutationCommands"
    import { useViewerUIStore } from "../stores/viewerUIStore.svelte"
    import { createViewerListCommands } from "../commands/viewerListCommands"
    import { withViewerInputShortcut } from "../commands/viewerInputShortcutCommand"
    import type {
        ViewerNoteDeletePayload,
        ViewerNoteEditPayload,
    } from "../commands/viewerCommandPayloads"
    import { tick, untrack } from "svelte"
    import { buildSidebarNavigationHints, findSidebarShortcut } from "./sidebarShortcutHints"

    const viewerUIStore = useViewerUIStore()

    let { onClose, interactive = true } = $props<{
        onClose: () => void
        interactive?: boolean
    }>()

    let searchQuery = $state("")
    let manualSelectedIndex = $state<number | null>(null)
    const phoneQuery = new MediaQuery("(max-width: 480px)")
    let searchInputRef = $state<HTMLInputElement | null>(null)
    let contentRef = $state<HTMLElement | undefined>()
    let isSearchFocused = $state(false)

    let normalizedSearchQuery = $derived(searchQuery.toLowerCase())
    let filteredNotes = $derived(
        notesStore.notes.filter(
            (note) =>
                note.text.toLowerCase().includes(normalizedSearchQuery) ||
                note.noteContent.toLowerCase().includes(normalizedSearchQuery),
        ),
    )

    async function selectNote(note: UserNote) {
        if (note.pageNumber === undefined) return

        notesStore.scrollingToNoteId = note.id
        if (window.innerWidth <= 480) {
            onClose()
            // Commit the closed sidebar before pushState snapshots the current history entry.
            await tick()
        }

        void commandsStore.execute("viewer.page.go-to", {
            page: note.pageNumber,
            isJump: true,
        })
    }

    let selectedIndex = $derived(
        resolveSelectionIndex(
            manualSelectedIndex,
            filteredNotes.length,
            phoneQuery.current ? -1 : 0,
        ),
    )

    function navigateSelection(direction: "next" | "prev") {
        if (filteredNotes.length === 0) return
        manualSelectedIndex =
            direction === "next"
                ? (selectedIndex + 1) % filteredNotes.length
                : (selectedIndex - 1 + filteredNotes.length) % filteredNotes.length
        scrollSelectedIntoView()
    }

    function handleSearchKeydown(event: KeyboardEvent) {
        if (event.key === "Enter") {
            event.preventDefault()
            const note = filteredNotes[selectedIndex]
            if (note) {
                selectNote(note)
                onClose()
            }
        }
    }

    function scrollSelectedIntoView() {
        requestAnimationFrame(() => {
            if (!contentRef) return
            contentRef.querySelector(".note-card.selected")?.scrollIntoView({ block: "nearest" })
        })
    }

    function resetSelection() {
        manualSelectedIndex = null
    }

    function trackSelection(_index: number, _notes: UserNote[]) {
        return (content: HTMLElement) => {
            contentRef = content
            scrollSelectedIntoView()
            return () => {
                if (contentRef === content) contentRef = undefined
            }
        }
    }

    const sidebarMutationCommands = createViewerMutationCommands({
        addBookmark: () => {},
        editBookmark: () => {},
        deleteBookmark: () => {},
        addNote: () => {},
        editNote: (payload: ViewerNoteEditPayload | undefined) => {
            const noteId = payload?.noteId ?? filteredNotes[selectedIndex]?.id
            const note = notesStore.notes.find(({ id }) => id === noteId)
            if (!note) return
            notesStore.editingNote = note
            notesStore.editorCoords = {
                x: payload?.x ?? window.innerWidth / 2,
                y: payload?.y ?? window.innerHeight / 2,
            }
        },
        saveNote: () => {},
        deleteNote: async (payload: ViewerNoteDeletePayload | undefined) => {
            const noteId = payload?.noteId ?? filteredNotes[selectedIndex]?.id
            if (!noteId) return
            if (!payload?.confirmed) {
                viewerUIStore.noteToDeleteId = noteId
                return
            }
            await notesStore.deleteNote(noteId)
            viewerUIStore.noteToDeleteId = null
        },
    })

    const listCommandsDisabled = () =>
        !interactive ||
        modalManager.hasBlockingModal ||
        !!notesStore.editingNote ||
        !!notesStore.activePopup

    function isEditableTarget(target: EventTarget | null) {
        return (
            target instanceof HTMLInputElement ||
            target instanceof HTMLTextAreaElement ||
            (target instanceof HTMLElement && target.isContentEditable)
        )
    }

    const shouldHandleListNavigation = (event: KeyboardEvent) =>
        !(
            isEditableTarget(event.target) &&
            (KeyboardHandler.matches(event, "j") || KeyboardHandler.matches(event, "k"))
        )

    const shouldHandleMutationKey = (event: KeyboardEvent, inputKey: string) =>
        !isEditableTarget(event.target) ||
        (isSearchFocused && KeyboardHandler.matches(event, inputKey))

    const listCommandScope = useCommands(
        [
            ...createViewerListCommands({
                nextLabel: () => m.keymap_next_note(),
                // Preserve English search terms in localized keyboard help.
                nextEnglishLabel: () => m.keymap_next_note({}, { locale: "en" }),
                previousLabel: () => m.keymap_prev_note(),
                previousEnglishLabel: () => m.keymap_prev_note({}, { locale: "en" }),
                selectLabel: () => m.keymap_open_note(),
                selectEnglishLabel: () => m.keymap_open_note({}, { locale: "en" }),
                searchLabel: () => m.keymap_search_notes(),
                searchEnglishLabel: () => m.keymap_search_notes({}, { locale: "en" }),
                disabled: listCommandsDisabled,
                shouldHandleNavigationKey: shouldHandleListNavigation,
                next: () => navigateSelection("next"),
                previous: () => navigateSelection("prev"),
                select: () => {
                    const note = filteredNotes[selectedIndex]
                    if (note) {
                        selectNote(note)
                        onClose()
                    }
                },
                search: () => {
                    searchInputRef?.focus()
                    searchInputRef?.select()
                },
            }),
            withViewerInputShortcut(
                sidebarMutationCommands["viewer.note.edit"]!,
                ["e", "ctrl+e"],
                listCommandsDisabled,
                (event) => shouldHandleMutationKey(event, "ctrl+e"),
            ),
            withViewerInputShortcut(
                sidebarMutationCommands["viewer.note.delete"]!,
                ["d", "ctrl+d"],
                listCommandsDisabled,
                (event) => shouldHandleMutationKey(event, "ctrl+d"),
            ),
        ],
        undefined,
        { autoActivate: untrack(() => interactive) },
    )

    let navigateShortcuts = $derived(
        buildSidebarNavigationHints(
            listCommandScope.getShortcut("viewer.list.next"),
            listCommandScope.getShortcut("viewer.list.previous"),
            isSearchFocused,
        ),
    )
    let selectShortcut = $derived(
        findSidebarShortcut(listCommandScope.getShortcut("viewer.list.select"), "enter"),
    )
    let searchShortcut = $derived(
        findSidebarShortcut(listCommandScope.getShortcut("viewer.list.search"), "/"),
    )
    let closeShortcut = $derived(
        findSidebarShortcut(listCommandScope.getShortcut("viewer.sidebar.close"), "escape"),
    )
    let editShortcut = $derived(
        findSidebarShortcut(
            listCommandScope.getShortcut("viewer.note.edit"),
            isSearchFocused ? "ctrl+e" : "e",
        ),
    )
    let deleteShortcut = $derived(
        findSidebarShortcut(
            listCommandScope.getShortcut("viewer.note.delete"),
            isSearchFocused ? "ctrl+d" : "d",
        ),
    )

    function formatTimestamp(timestamp: number): string {
        return new Date(timestamp).toLocaleString(undefined, {
            dateStyle: "short",
            timeStyle: "short",
        })
    }

    function triggerEdit(note: UserNote, event: MouseEvent) {
        event.stopPropagation()
        void executeViewerNoteEdit({
            noteId: note.id,
            x: event.clientX,
            y: event.clientY,
        })
    }

    function triggerDelete(note: UserNote, event: MouseEvent) {
        event.stopPropagation()
        void executeViewerNoteDelete({ noteId: note.id })
    }
</script>

<SidebarSearch
    bind:ref={searchInputRef}
    bind:value={searchQuery}
    oninput={resetSelection}
    onClear={resetSelection}
    placeholder={`${m.search_notes_placeholder()} [${searchShortcut}]`}
    onkeydown={handleSearchKeydown}
    bind:focused={isSearchFocused}
    clearLabel={m.clear_search_aria()}
/>

<div class="sidebar-content" {@attach trackSelection(selectedIndex, filteredNotes)}>
    {#if notesStore.notes.length === 0}
        <div class="no-notes">
            {m.no_notes()}
        </div>
    {:else if filteredNotes.length === 0}
        <div class="no-notes">{m.no_matching_notes()}</div>
    {:else}
        <div class="notes-list">
            {#each filteredNotes as note, index (note.id)}
                <article
                    class="note-card color-{note.color}"
                    class:selected={index === selectedIndex}
                >
                    <button
                        type="button"
                        class="note-primary"
                        aria-current={index === selectedIndex ? "location" : undefined}
                        onclick={() => {
                            selectNote(note)
                            manualSelectedIndex = index
                        }}
                    >
                        <span class="note-card-header">
                            <span class="note-page">{m.page()} {note.pageNumber}</span>
                            <span class="note-date">{formatTimestamp(note.createdAt)}</span>
                        </span>
                        <span class="note-highlight">“{note.text}”</span>
                        {#if note.noteContent}
                            <span class="note-text-content">{note.noteContent}</span>
                        {/if}
                    </button>

                    <div class="note-card-actions">
                        <button
                            type="button"
                            class="action-btn edit"
                            onclick={(event) => triggerEdit(note, event)}
                            aria-label={m.edit_note()}
                            title={m.edit_note()}
                        >
                            <EditIcon width="14" height="14" />
                        </button>
                        <button
                            type="button"
                            class="action-btn delete"
                            onclick={(event) => triggerDelete(note, event)}
                            aria-label={m.delete_note()}
                            title={m.delete_note()}
                        >
                            <TrashIcon width="14" height="14" />
                        </button>
                    </div>
                </article>
            {/each}
        </div>
    {/if}
</div>

{#if !viewport.isCompact}
    <SidebarFooter>
        <span class="hint-item">
            {#each navigateShortcuts as pair, i (pair.display)}
                {#if i > 0},
                {/if}<kbd>{pair.display}</kbd>
            {/each}
            {m.navigate()}
        </span>
        <span class="hint-divider">•</span>
        <span class="hint-item"><kbd>{selectShortcut}</kbd> {m.go()}</span>
        <span class="hint-divider">•</span>
        {#if isSearchFocused}
            <span class="hint-item"><kbd>{closeShortcut}</kbd> {m.close_search()}</span>
        {:else}
            <span class="hint-item"><kbd>{searchShortcut}</kbd> {m.search()}</span>
        {/if}
        <span class="hint-divider">•</span>
        <span class="hint-item"><kbd>{editShortcut}</kbd> {m.edit()}</span>
        <span class="hint-divider">•</span>
        <span class="hint-item"><kbd>{deleteShortcut}</kbd> {m.delete()}</span>
    </SidebarFooter>
{/if}

<style>
    .sidebar-content {
        flex: 1;
        overflow-y: auto;
        padding: 12px 12px calc(12px + var(--sidebar-safe-area-end, 0px));
        background: transparent;
        overscroll-behavior: contain;
    }

    .no-notes {
        padding: 24px;
        text-align: center;
        font-size: var(--font-size-md);
        font-weight: 700;
        color: var(--faded-text-color);
        line-height: 1.5;
    }

    .notes-list {
        display: flex;
        flex-direction: column;
        gap: 12px;
    }

    .note-card {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        align-items: stretch;
        gap: 6px;
        background: var(--surface-color);
        border: var(--border-inline) solid var(--border-color);
        border-left-width: 3px;
        border-radius: var(--radius-md);
        transition: background-color 0.12s ease;
    }

    .note-card:hover,
    .note-card:focus-within {
        background: var(--surface-hover-color);
    }

    .note-card.selected {
        background: var(--selected-surface);
        outline: 1px solid var(--selection-color);
    }

    .note-primary {
        display: flex;
        min-width: 0;
        flex-direction: column;
        align-items: stretch;
        gap: 6px;
        padding: 10px 12px;
        border: 0;
        background: transparent;
        color: var(--text-color);
        font: inherit;
        text-align: left;
        cursor: pointer;
    }

    .note-primary:focus-visible {
        outline: 2px solid var(--focus-color);
        outline-offset: -3px;
    }

    /* Colors mapped */
    .note-card.color-yellow {
        border-left-color: #c49b00;
    }
    .note-card.color-green {
        border-left-color: #1f9669;
    }
    .note-card.color-blue {
        border-left-color: #1d6fd3;
    }
    .note-card.color-pink {
        border-left-color: #d63384;
    }
    .note-card.color-purple {
        border-left-color: #815ab2;
    }

    .note-card-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        font-size: var(--font-size-xs);
        font-weight: 500;
        color: var(--faded-text-color);
    }

    .note-card.selected .note-card-header {
        color: var(--text-color);
    }

    .note-page {
        background: var(--muted-bg-color);
        color: var(--muted-text-color);
        border: 1px solid var(--border-color);
        padding: 1px 4px;
        border-radius: var(--radius-sm);
    }

    .note-highlight {
        margin: 0;
        font-style: italic;
        font-size: var(--font-size-sm);
        color: var(--text-color);
        background: var(--faded-color);
        padding: 4px 8px;
        border-left: 2px solid var(--border-color);
        max-height: 120px;
        overflow-y: auto;
        word-break: break-word;
    }

    .note-text-content {
        font-size: var(--font-size-base);
        font-weight: 700;
        color: var(--text-color);
        line-height: 1.4;
        word-break: break-word;
    }

    .note-card-actions {
        display: flex;
        flex-direction: column;
        justify-content: center;
        gap: 4px;
        align-self: stretch;
        padding-right: 8px;
        opacity: 0.72;
        transition: opacity 0.15s ease;
    }

    .note-card:hover .note-card-actions,
    .note-card:focus-within .note-card-actions {
        opacity: 1;
    }

    .action-btn {
        width: 28px;
        height: 28px;
        background: var(--surface-color);
        cursor: pointer;
        padding: 4px;
        color: var(--text-color);
        display: flex;
        align-items: center;
        justify-content: center;
        border-radius: var(--radius-sm);
        border: 1px solid var(--border-color);
        transition:
            background-color 0.1s ease,
            border-color 0.1s ease,
            color 0.1s ease;
    }

    .action-btn:hover {
        background: var(--surface-hover-color);
        border-color: var(--border-color);
    }

    .action-btn.delete:hover {
        color: var(--danger-color);
        background: color-mix(in srgb, var(--danger-color) 12%, transparent);
    }

    @media (max-width: 640px) {
        .note-card {
            grid-template-columns: minmax(0, 1fr);
        }

        .note-card-actions {
            flex-direction: row;
            justify-content: flex-end;
            align-self: auto;
            padding: 0 12px 10px;
            opacity: 1;
        }

        .action-btn {
            width: 34px;
            height: 34px;
            padding: 8px;
        }

        .note-primary {
            min-height: 48px;
            padding: 12px 14px;
        }
    }

    @media (max-width: 480px) {
        .action-btn :global(svg) {
            width: 16px !important;
            height: 16px !important;
        }
    }
</style>
