<script lang="ts">
    import { viewport } from "$lib/shared/state/viewport.svelte"
    import * as m from "$lib/paraglide/messages"
    import {
        useCommands,
        KeyboardHandler,
        commandsStore,
        type CommandScope,
    } from "$lib/core/commands"
    import { MediaQuery } from "svelte/reactivity"
    import Button from "$lib/shared/ui/Button.svelte"
    import { resolveSelectionIndex } from "$lib/shared/state/listSelection"
    import { viewerStore } from "../stores/viewerStore.svelte"
    import { bookmarksStore } from "../stores/bookmarksStore.svelte"
    import { executeViewerCommand } from "../viewerHost"
    import type { Bookmark } from "$lib/core/documents"
    import type { ViewerBookmarkEditPayload } from "../commands/viewerCommandPayloads"
    import TrashIcon from "$lib/shared/icons/TrashIcon.svelte"
    import EditIcon from "$lib/shared/icons/EditIcon.svelte"
    import Modal from "$lib/shared/ui/modal/Modal.svelte"
    import { modalManager } from "$lib/shared/ui/modal/modalManager.svelte"
    import Input from "$lib/shared/ui/Input.svelte"
    import { SidebarFooter, SidebarSearch } from "$lib/shared/ui/sidebar"
    import DeleteConfirmModal from "./DeleteConfirmModal.svelte"
    import BookmarkEditKeymaps from "./BookmarkEditKeymaps.svelte"
    import { createViewerMutationCommands } from "../commands/viewerMutationCommands"
    import {
        executeViewerBookmarkDelete,
        executeViewerBookmarkEdit,
    } from "../commands/viewerMutationExecution"
    import { createViewerListCommands } from "../commands/viewerListCommands"
    import { withViewerInputShortcut } from "../commands/viewerInputShortcutCommand"
    import { tick, untrack } from "svelte"
    import { buildSidebarNavigationHints, findSidebarShortcut } from "./sidebarShortcutHints"

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

    let editingBookmarkId = $state<string | null>(null)
    let editingName = $state("")
    let bookmarkToDeleteId = $state<string | null>(null)
    let bookmarkEditScope = $state.raw<CommandScope>()

    function focusBookmarkName(input: HTMLInputElement) {
        const frame = requestAnimationFrame(() => {
            input.focus()
            input.select()
        })
        return () => cancelAnimationFrame(frame)
    }

    let currentBook = $derived(viewerStore.getCurrentBook())
    let currentBookId = $derived(currentBook?.id)

    let normalizedSearchQuery = $derived(searchQuery.toLowerCase())
    let filteredBookmarks = $derived(
        bookmarksStore.bookmarks
            .filter(
                (bookmark) =>
                    bookmark.bookId === currentBookId &&
                    bookmark.name.toLowerCase().includes(normalizedSearchQuery),
            )
            .sort((a, b) => a.pageNumber - b.pageNumber),
    )

    function getBookmarkEditPayload(): ViewerBookmarkEditPayload {
        return {
            bookmarkId: editingBookmarkId ?? undefined,
            name: editingName.trim(),
        }
    }

    async function selectBookmark(bookmark: Bookmark) {
        if (bookmark.pageNumber === undefined) return

        if (window.innerWidth <= 480) {
            onClose()
            // Commit the closed sidebar before navigation updates browser history.
            await tick()
        }

        void executeViewerCommand("viewer.bookmark.open", { bookmarkId: bookmark.id })
    }

    let selectedIndex = $derived(
        resolveSelectionIndex(
            manualSelectedIndex,
            filteredBookmarks.length,
            phoneQuery.current ? -1 : 0,
        ),
    )

    function navigateSelection(direction: "next" | "prev") {
        if (filteredBookmarks.length === 0) return
        manualSelectedIndex =
            direction === "next"
                ? (selectedIndex + 1) % filteredBookmarks.length
                : (selectedIndex - 1 + filteredBookmarks.length) % filteredBookmarks.length
        scrollSelectedIntoView()
    }

    function handleSearchKeydown(event: KeyboardEvent) {
        if (event.key === "Enter") {
            event.preventDefault()
            const bookmark = filteredBookmarks[selectedIndex]
            if (bookmark) {
                selectBookmark(bookmark)
                onClose()
            }
        }
    }

    function scrollSelectedIntoView() {
        requestAnimationFrame(() => {
            if (!contentRef) return
            contentRef
                .querySelector(".bookmark-card.selected")
                ?.scrollIntoView({ block: "nearest" })
        })
    }

    function resetSelection() {
        manualSelectedIndex = null
    }

    function trackSelection(_index: number, _bookmarks: Bookmark[]) {
        return (content: HTMLElement) => {
            contentRef = content
            scrollSelectedIntoView()
            return () => {
                if (contentRef === content) contentRef = undefined
            }
        }
    }

    const applyBookmarkEdit = async (
        payload: { bookmarkId?: string; name?: string } | undefined,
    ) => {
        const bookmarkId = payload?.bookmarkId ?? filteredBookmarks[selectedIndex]?.id
        const bookmark = bookmarksStore.bookmarks.find(({ id }) => id === bookmarkId)
        if (!bookmark) return
        if (payload?.name?.trim()) {
            await bookmarksStore.updateBookmark(bookmark.id, payload.name.trim())
            editingBookmarkId = null
            return
        }
        editingBookmarkId = bookmark.id
        editingName = bookmark.name
    }

    const sidebarMutationCommands = createViewerMutationCommands({
        addBookmark: () => {},
        editBookmark: applyBookmarkEdit,
        deleteBookmark: async (
            payload: { bookmarkId?: string; confirmed?: boolean } | undefined,
        ) => {
            const bookmarkId = payload?.bookmarkId ?? filteredBookmarks[selectedIndex]?.id
            if (!bookmarkId) return
            if (!payload?.confirmed) {
                bookmarkToDeleteId = bookmarkId
                return
            }
            await bookmarksStore.deleteBookmark(bookmarkId)
            bookmarkToDeleteId = null
        },
        addNote: () => {},
        editNote: () => {},
        saveNote: () => {},
        deleteNote: () => {},
    })

    const listCommandsDisabled = () =>
        !interactive ||
        filteredBookmarks.length === 0 ||
        modalManager.hasBlockingModal ||
        !!editingBookmarkId ||
        !!bookmarkToDeleteId

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
                nextLabel: () => m.keymap_next_bookmark(),
                // Preserve English search terms in localized keyboard help.
                nextEnglishLabel: () => m.keymap_next_bookmark({}, { locale: "en" }),
                previousLabel: () => m.keymap_prev_bookmark(),
                previousEnglishLabel: () => m.keymap_prev_bookmark({}, { locale: "en" }),
                selectLabel: () => m.keymap_open_bookmark(),
                selectEnglishLabel: () => m.keymap_open_bookmark({}, { locale: "en" }),
                searchLabel: () => m.search_bookmarks(),
                searchEnglishLabel: () => m.search_bookmarks({}, { locale: "en" }),
                disabled: listCommandsDisabled,
                shouldHandleNavigationKey: shouldHandleListNavigation,
                next: () => navigateSelection("next"),
                previous: () => navigateSelection("prev"),
                select: () => {
                    const bookmark = filteredBookmarks[selectedIndex]
                    if (bookmark) {
                        selectBookmark(bookmark)
                        onClose()
                    }
                },
                search: () => {
                    searchInputRef?.focus()
                    searchInputRef?.select()
                },
            }),
            withViewerInputShortcut(
                sidebarMutationCommands["viewer.bookmark.edit"]!,
                ["e", "ctrl+e"],
                listCommandsDisabled,
                (event) => shouldHandleMutationKey(event, "ctrl+e"),
            ),
            withViewerInputShortcut(
                sidebarMutationCommands["viewer.bookmark.delete"]!,
                ["d", "ctrl+d"],
                listCommandsDisabled,
                (event) => !bookmarkToDeleteId && shouldHandleMutationKey(event, "ctrl+d"),
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
            listCommandScope.getShortcut("viewer.bookmark.edit"),
            isSearchFocused ? "ctrl+e" : "e",
        ),
    )
    let deleteShortcut = $derived(
        findSidebarShortcut(
            listCommandScope.getShortcut("viewer.bookmark.delete"),
            isSearchFocused ? "ctrl+d" : "d",
        ),
    )

    function confirmBookmarkEdit() {
        void bookmarkEditScope?.execute("viewer.bookmark.edit", {
            bookmarkId: editingBookmarkId ?? undefined,
            name: editingName.trim(),
        })
    }
</script>

<SidebarSearch
    bind:ref={searchInputRef}
    bind:value={searchQuery}
    oninput={resetSelection}
    onClear={resetSelection}
    placeholder={`${m.search_bookmarks_placeholder()} [${searchShortcut}]`}
    onkeydown={handleSearchKeydown}
    bind:focused={isSearchFocused}
    clearLabel={m.clear_search_aria()}
/>

<div class="sidebar-content" {@attach trackSelection(selectedIndex, filteredBookmarks)}>
    {#if filteredBookmarks.length === 0}
        <div class="no-bookmarks">
            {m.no_bookmarks()}
        </div>
    {:else}
        <div class="bookmarks-list">
            {#each filteredBookmarks as bookmark, index (bookmark.id)}
                <article class="bookmark-card" class:selected={index === selectedIndex}>
                    <button
                        type="button"
                        class="bookmark-primary"
                        aria-current={index === selectedIndex ? "location" : undefined}
                        onclick={() => {
                            selectBookmark(bookmark)
                            manualSelectedIndex = index
                        }}
                    >
                        <span class="bookmark-card-header">
                            <span class="bookmark-page">{m.page()} {bookmark.pageNumber}</span>
                        </span>
                        <span class="bookmark-text-content">{bookmark.name}</span>
                    </button>
                    <div class="bookmark-card-actions">
                        <button
                            type="button"
                            class="action-btn edit"
                            onclick={() =>
                                void executeViewerBookmarkEdit({ bookmarkId: bookmark.id })}
                            aria-label={m.edit_bookmark()}
                            title={m.edit_bookmark()}
                        >
                            <EditIcon width="14" height="14" />
                        </button>
                        <button
                            type="button"
                            class="action-btn delete"
                            onclick={() =>
                                void executeViewerBookmarkDelete({ bookmarkId: bookmark.id })}
                            aria-label={m.remove_bookmark()}
                            title={m.remove_bookmark()}
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

{#if editingBookmarkId}
    <BookmarkEditKeymaps
        onConfirm={applyBookmarkEdit}
        getPayload={getBookmarkEditPayload}
        onCancel={() => (editingBookmarkId = null)}
        bind:scope={bookmarkEditScope}
    />
    <Modal
        variant="default"
        type="float"
        size="medium"
        placement="center"
        onClose={() => void bookmarkEditScope?.execute("modal.cancel")}
        title={m.rename_bookmark()}
        closeLabel={m.close()}
        initialFocus={() => document.getElementById("edit-bookmark-name-input")}
        draggable
    >
        <div class="modal-form">
            <Input
                id="edit-bookmark-name-input"
                attachment={focusBookmarkName}
                placeholder={m.bookmark_name_placeholder()}
                label={m.rename_bookmark()}
                bind:value={editingName}
                onkeydown={(e) => {
                    if (e.key === "Enter" && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
                        e.preventDefault()
                        confirmBookmarkEdit()
                    }
                }}
            />
        </div>

        {#snippet footer()}
            <div class="modal-actions">
                <Button
                    variant="close"
                    onclick={() => void bookmarkEditScope?.execute("modal.cancel")}
                >
                    {m.cancel()}
                </Button>
                <Button variant="brutalist" onclick={confirmBookmarkEdit}>
                    {m.save()}
                </Button>
            </div>
        {/snippet}
    </Modal>
{/if}

{#if bookmarkToDeleteId}
    <DeleteConfirmModal
        message={m.delete_bookmark_confirm()}
        onConfirm={async () => {
            if (bookmarkToDeleteId) {
                await executeViewerBookmarkDelete({
                    bookmarkId: bookmarkToDeleteId,
                    confirmed: true,
                })
            }
            bookmarkToDeleteId = null
        }}
        onCancel={() => {
            bookmarkToDeleteId = null
        }}
    />
{/if}

<style>
    .sidebar-content {
        flex: 1;
        overflow-y: auto;
        padding: 12px 12px calc(12px + var(--sidebar-safe-area-end, 0px));
        overscroll-behavior: contain;
    }

    .no-bookmarks {
        padding: 24px;
        text-align: center;
        font-size: var(--font-size-md);
        font-weight: 700;
        color: var(--faded-text-color);
        line-height: 1.5;
    }

    .bookmarks-list {
        display: flex;
        flex-direction: column;
        gap: 12px;
    }

    .bookmark-card {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        align-items: stretch;
        gap: 6px;
        background: var(--surface-color);
        border: var(--border-inline) solid var(--border-color);
        box-shadow: 3px 3px 0 var(--shadow-color);
        transition:
            background-color 0.15s ease-out,
            box-shadow 0.15s ease-out,
            transform 0.15s ease-out;
    }

    .bookmark-card:hover,
    .bookmark-card:focus-within {
        transform: translate(-1px, -1px);
        background: var(--surface-hover-color);
        box-shadow: 4px 4px 0 var(--shadow-color);
    }

    .bookmark-card.selected {
        background: var(--selected-surface);
        box-shadow:
            4px 4px 0 var(--shadow-color),
            inset 5px 0 0 var(--accent-active-color);
    }

    .bookmark-primary {
        display: flex;
        min-width: 0;
        flex-direction: column;
        align-items: flex-start;
        gap: 6px;
        padding: 10px 12px;
        border: 0;
        background: transparent;
        color: var(--text-color);
        font: inherit;
        text-align: left;
        cursor: pointer;
    }

    .bookmark-primary:focus-visible {
        outline: 2px solid var(--focus-color);
        outline-offset: -3px;
    }

    .bookmark-card-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        font-size: var(--font-size-xs);
        font-weight: 900;
        text-transform: uppercase;
        color: var(--faded-text-color);
    }

    .bookmark-card.selected .bookmark-card-header {
        color: var(--text-color);
    }

    .bookmark-page {
        background: var(--muted-bg-color);
        color: var(--muted-text-color);
        border: 1px solid var(--border-color);
        padding: 1px 4px;
        border-radius: var(--radius-sm);
    }

    .bookmark-text-content {
        font-size: var(--font-size-md);
        font-weight: 700;
        color: var(--text-color);
        line-height: 1.4;
        word-break: break-word;
    }

    .bookmark-card-actions {
        display: flex;
        justify-content: flex-end;
        gap: 6px;
        margin-top: 4px;
        align-self: center;
        padding-right: 8px;
        opacity: 0.72;
        transition: opacity 0.15s ease;
    }

    .bookmark-card:hover .bookmark-card-actions,
    .bookmark-card:focus-within .bookmark-card-actions {
        opacity: 1;
    }

    .action-btn {
        background: none;
        border: none;
        cursor: pointer;
        padding: 4px;
        color: var(--text-color);
        display: flex;
        align-items: center;
        justify-content: center;
        border-radius: var(--radius-sm);
        border: 1px solid transparent;
        transition:
            background-color 0.1s ease,
            border-color 0.1s ease,
            color 0.1s ease;
    }

    .action-btn:hover {
        background: var(--accent-color);
        border-color: var(--border-color);
    }

    .action-btn.delete:hover {
        color: var(--danger-color);
        background: color-mix(in srgb, var(--danger-color) 12%, transparent);
    }

    @media (max-width: 640px) {
        .bookmark-card-actions {
            opacity: 1;
        }

        .action-btn {
            padding: 8px;
        }

        .bookmark-primary {
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
