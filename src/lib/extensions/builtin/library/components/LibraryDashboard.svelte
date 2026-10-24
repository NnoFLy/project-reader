<script lang="ts">
    import { mountLibraryUI } from "../state/libraryUI.svelte"

    const libraryUI = mountLibraryUI()
    import { viewport } from "$lib/shared/state/viewport.svelte"
    import * as m from "$lib/paraglide/messages"
    import Header from "./Header.svelte"
    import BookImporter from "./BookImporter.svelte"
    import BookIcon from "$lib/shared/icons/BookIcon.svelte"
    import TerminalIcon from "$lib/shared/icons/TerminalIcon.svelte"
    import Breadcrumbs from "./Breadcrumbs.svelte"
    import TrashIcon from "$lib/shared/icons/TrashIcon.svelte"
    import NavigationIcon from "$lib/shared/icons/NavigationIcon.svelte"
    import CheckIcon from "$lib/shared/icons/CheckIcon.svelte"
    import MinusIcon from "$lib/shared/icons/MinusIcon.svelte"
    import NewFolderIcon from "$lib/shared/icons/NewFolderIcon.svelte"
    import PinIcon from "$lib/shared/icons/PinIcon.svelte"
    import BookOpenIcon from "$lib/shared/icons/BookOpenIcon.svelte"
    import CheckCircleIcon from "$lib/shared/icons/CheckCircleIcon.svelte"
    import Button from "$lib/shared/ui/Button.svelte"

    import { vfsStore } from "../state/libraryStore.svelte"
    import Card from "./Card.svelte"
    import { modalManager } from "$lib/shared/ui/modal/modalManager.svelte"
    import NewFolderModal from "./NewFolderModal.svelte"
    import DeleteConfirmModal from "./DeleteConfirmModal.svelte"
    import EditBookMetadataModal from "./EditBookMetadataModal.svelte"
    import RenameFolderModal from "./RenameFolderModal.svelte"
    import { useCommands } from "../commands/commandsStore.svelte"
    import { createLibraryCommands } from "../commands/libraryCommands"
    import { createLibraryFolder } from "../commands/libraryCommandExecution"
    import { confirmLibraryNodeDelete } from "../commands/libraryNodeDeleteConfirmation"
    import { page } from "$app/state"
    import { goto } from "$app/navigation"
    import { resolve } from "$app/paths"
    import { localizedPath } from "../state/librarySettings"
    import type { VFSNode } from "../state/libraryStore.svelte"
    import PickerModeKeymaps from "./PickerModeKeymaps.svelte"
    import PickerKey from "./PickerKey.svelte"
    import { PICKER_KEYS, generateHints } from "../utils/constants"
    import { navigateGrid } from "../utils/gridNavigation"
    import { onDestroy, tick, untrack } from "svelte"
    import { settingsStore } from "../state/librarySettings"
    import { createLibraryDashboardInteractionCommands } from "../commands/libraryDashboardInteractionCommands"
    import { mergeLibraryEntries } from "../utils/libraryEntries"
    import { executeLibraryHostCommand } from "../state/libraryHostBridge"

    const libraryCommands = createLibraryCommands(libraryUI)

    onDestroy(() => {
        libraryUI.metadataEditorNodeIds = []
    })

    let pickingMode = $state<"startSelection" | "openFileFolder" | "focusCard">("openFileFolder")

    const displayEntries = $derived(
        mergeLibraryEntries(
            vfsStore.sortedCurrentNodes,
            vfsStore.importJobs,
            vfsStore.currentFolderId,
        ),
    )
    const currentNodes = $derived(
        displayEntries.flatMap((entry) => (entry.interactive && entry.node ? [entry.node] : [])),
    )
    const interactiveIndex = $derived(new Map(currentNodes.map((node, index) => [node.id, index])))

    let pickerKeyBuffer = $state("")
    const currentHints = $derived(generateHints(currentNodes.length, PICKER_KEYS))

    $effect(() => {
        if (!vfsStore.initialized) return

        const folderParam = page.url.searchParams.get("folder")
        let resolvedId: string | null = null
        if (folderParam) {
            if (folderParam.startsWith("/")) {
                resolvedId = vfsStore.getFolderIdByPath(folderParam)
            } else {
                const node = vfsStore.nodes[folderParam]
                if (node && node.type === "folder") {
                    resolvedId = folderParam
                } else {
                    resolvedId = vfsStore.getFolderIdByPath(folderParam)
                }
            }
        }

        if (vfsStore.currentFolderId !== resolvedId) {
            vfsStore.clearFailedImports()
            vfsStore.currentFolderId = resolvedId
            untrack(() => {
                libraryUI.isSelectionMode = false
                libraryUI.isPickingMode = false
                vfsStore.clearSelection()
                pickerKeyBuffer = ""
                lastFocusedCardId = null
            })
        }
    })

    let breadcrumbs = $derived.by(() => {
        const segments: Array<{ name: string; id: string | null }> = [
            { name: m.library(), id: null },
        ]
        let currentId = vfsStore.currentFolderId
        const pathNodes: any[] = []
        while (currentId !== null) {
            const node = vfsStore.nodes[currentId]
            if (node && node.type === "folder") {
                pathNodes.unshift(node)
                currentId = node.parentId
            } else {
                break
            }
        }
        for (const node of pathNodes) {
            segments.push({ name: node.name, id: node.id })
        }
        return segments
    })

    const allSelected = $derived(
        currentNodes.length > 0 && currentNodes.every((node) => vfsStore.selectedIds.has(node.id)),
    )
    const selectedNodes = $derived(currentNodes.filter((node) => vfsStore.selectedIds.has(node.id)))
    const selectedBooks = $derived(selectedNodes.filter((node) => node.type === "file"))
    const allSelectedPinned = $derived(
        selectedNodes.length > 0 && selectedNodes.every((node) => node.isPinned),
    )

    function isReadNode(node: VFSNode) {
        return (
            node.type === "file" &&
            node.metadata.totalPages !== undefined &&
            node.metadata.totalPages > 0 &&
            (node.metadata.pageNumber || 1) === node.metadata.totalPages
        )
    }

    const allSelectedBooksRead = $derived(
        selectedBooks.length > 0 && selectedBooks.every((node) => isReadNode(node)),
    )

    async function toggleSelectedPinned() {
        const isPinned = !allSelectedPinned
        for (const node of selectedNodes) {
            await libraryCommandScope.execute("library.node.pin.toggle", {
                nodeId: node.id,
                isPinned,
            })
        }
    }

    async function toggleSelectedReadState() {
        const markAsRead = !allSelectedBooksRead
        for (const node of selectedBooks) {
            if (node.type !== "file") continue
            await libraryCommandScope.execute("library.book.read-state.toggle", {
                nodeId: node.id,
                markAsRead,
            })
        }
    }

    async function handleNodeClick(e: MouseEvent | KeyboardEvent | null, node: VFSNode) {
        const isEnter = e && e instanceof KeyboardEvent && e.key === "Enter"
        if (!isEnter && (libraryUI.isSelectionMode || e?.metaKey || e?.ctrlKey)) {
            await libraryCommandScope.execute("library.selection.toggle", { nodeId: node.id })
            return
        }
        if (node.type === "folder") {
            await libraryCommandScope.execute("library.folder.open", { folderId: node.id })
        } else {
            await executeLibraryHostCommand("viewer.open", { bookId: node.id })
        }
    }

    function handlePickerSelect(node: VFSNode) {
        if (pickingMode === "startSelection") {
            libraryUI.isSelectionMode = true
            vfsStore.toggleSelection(node.id)
        } else if (pickingMode === "openFileFolder") {
            handleNodeClick(null as any, node)
            libraryUI.isPickingMode = false
        } else if (pickingMode === "focusCard") {
            tick().then(() => {
                const el = document.querySelector(
                    `.card[data-id="${node.id}"]`,
                ) as HTMLElement | null
                if (el) {
                    el.focus()
                    lastFocusedCardId = node.id
                }
            })
            libraryUI.isPickingMode = false
        }
    }

    function startPicker(mode: typeof pickingMode) {
        if (mode !== "openFileFolder" || !libraryUI.isSelectionMode) {
            pickingMode = mode
        }
        pickerKeyBuffer = ""
        libraryUI.isPickingMode = true
    }

    function goUpFolder() {
        if (vfsStore.currentFolderId === null) return
        const currentFolder = vfsStore.nodes[vfsStore.currentFolderId]
        if (!currentFolder) return
        const parentId = currentFolder.parentId
        if (parentId) {
            const path = vfsStore.getFolderPath(parentId)
            void goto(resolve((localizedPath("/") + `?folder=${encodeURIComponent(path)}`) as any))
        } else {
            void goto(resolve(localizedPath("/") as any))
        }
    }

    const libraryCommandScope = useCommands([
        ...createLibraryDashboardInteractionCommands({
            gridDisabled: () => libraryUI.isPickingMode,
            moveGrid: (direction, repeated) =>
                navigateGrid(direction, lastFocusedCardId, settingsStore.animations, repeated),
            startOpenPicker: () => startPicker("openFileFolder"),
            startFocusPicker: () => startPicker("focusCard"),
            startSelectionPicker: () => startPicker("startSelection"),
            goUpFolder,
            decreaseCardSize: () => libraryUI.decreaseCardSize(),
            increaseCardSize: () => libraryUI.increaseCardSize(),
            cardSizeDecreaseDisabled: () =>
                libraryUI.isPickingMode ||
                modalManager.hasBlockingModal ||
                !libraryUI.canDecreaseCardSize,
            cardSizeIncreaseDisabled: () =>
                libraryUI.isPickingMode ||
                modalManager.hasBlockingModal ||
                !libraryUI.canIncreaseCardSize,
            labels: {
                down: () => m.keymap_grid_select_down(),
                up: () => m.keymap_grid_select_up(),
                left: () => m.keymap_grid_select_left(),
                right: () => m.keymap_grid_select_right(),
                openPicker: () => m.pick_file_to_open(),
                focusPicker: () => m.pick_file_to_focus(),
                selectionPicker: () => m.pick_file_to_open(),
                upFolder: () => m.keymap_up_folder(),
                cardSizeDecrease: () => m.keymap_decrease_card_size(),
                cardSizeIncrease: () => m.keymap_increase_card_size(),
            },
            englishLabels: {
                down: () => "Select item below",
                up: () => "Select item above",
                left: () => "Select item left",
                right: () => "Select item right",
                openPicker: () => m.pick_file_to_open({}, { locale: "en" }),
                focusPicker: () => m.pick_file_to_focus({}, { locale: "en" }),
                selectionPicker: () => m.pick_file_to_open({}, { locale: "en" }),
                upFolder: () => m.keymap_up_folder({}, { locale: "en" }),
                cardSizeDecrease: () => m.keymap_decrease_card_size({}, { locale: "en" }),
                cardSizeIncrease: () => m.keymap_increase_card_size({}, { locale: "en" }),
            },
        }),
        libraryCommands["library.book.open-recursive"],
        libraryCommands["library.book.read-state.toggle"],
        libraryCommands["library.folder.open"],
        libraryCommands["library.primary-action"],

        libraryCommands["library.continue-reading"],
        libraryCommands["library.selection.clear"],
        libraryCommands["library.selection.move"],
        libraryCommands["library.selection.delete"],
        libraryCommands["library.selection.toggle"],
        libraryCommands["library.selection.all"],
        libraryCommands["library.folder.create"],
        libraryCommands["library.node.rename"],
        libraryCommands["library.node.move"],
        libraryCommands["library.node.pin.toggle"],
        libraryCommands["library.node.delete"],
        libraryCommands["library.node.edit-metadata"],
        libraryCommands["library.node.relink"],
    ])

    let lastFocusedCardId = $state<string | null>(null)

    function handleCardFocus(e: FocusEvent) {
        const card = (e.target as HTMLElement).closest(".card") as HTMLElement | null
        if (card) {
            const id = card.getAttribute("data-id")
            if (id) {
                lastFocusedCardId = id
            }
        }
    }

    async function restoreCardFocus() {
        if (!lastFocusedCardId) return
        await tick()
        const card = document.querySelector(
            `.card[data-id="${lastFocusedCardId}"]`,
        ) as HTMLElement | null
        if (card) {
            card.focus()
        } else {
            // Fallback: if the card is gone (e.g. deleted), focus the first card in the list
            const firstCard = document.querySelector(
                ".card_list.grid .card:not(:disabled)",
            ) as HTMLElement | null
            if (firstCard) {
                firstCard.focus()
            }
        }
    }

    let wasModalOpen = false
    $effect(() => {
        const isModalOpen = modalManager.hasBlockingModal
        if (!isModalOpen && wasModalOpen) {
            restoreCardFocus()
        }
        wasModalOpen = isModalOpen
    })

    $effect(() => {
        if (libraryUI.isSelectionMode && vfsStore.selectedIds.size === 0) {
            untrack(() => {
                libraryUI.isSelectionMode = false
            })
        }
    })

    $effect(() => {
        if (!libraryUI.isPickingMode) {
            untrack(() => {
                pickerKeyBuffer = ""
            })
        }
    })
</script>

<div class="container">
    <Header />
    {#if vfsStore.readingCleanupPending}
        <section class="cleanup-status" role="status" aria-label={m.reading_cleanup_retry()}>
            <p>{m.reading_cleanup_pending()}</p>
            <Button
                disabled={vfsStore.readingCleanupBusy}
                onclick={() => void vfsStore.resumeReadingDeletions().catch(() => false)}
            >
                {vfsStore.readingCleanupBusy ? m.reading_cleanup_busy() : m.reading_cleanup_retry()}
            </Button>
        </section>
    {/if}
    <Breadcrumbs {breadcrumbs} />

    <div class="library-actions" role="toolbar" aria-label={m.action_controls()}>
        {#if displayEntries.length !== 0 || vfsStore.currentFolderId !== null}
            <BookImporter variant="action" />
        {/if}
        <Button
            variant="ghost"
            size="default"
            Icon={NewFolderIcon}
            onclick={() => void libraryCommandScope.execute("library.folder.create")}
        >
            <span>{m.new_folder()}</span>
        </Button>
    </div>

    {#if libraryUI.isNewFolderModalOpen}
        <NewFolderModal onCreate={createLibraryFolder} />
    {/if}

    {#if libraryUI.isDeleteModalOpen}
        <DeleteConfirmModal
            message={libraryUI.nodesToDeleteIds.length > 1
                ? m.delete_confirmation_multiple({ count: libraryUI.nodesToDeleteIds.length })
                : m.delete_confirmation_single()}
            onConfirm={async () => {
                const nodeIds = [...libraryUI.nodesToDeleteIds]
                if (nodeIds.length === 1 && !libraryUI.isSelectionMode) {
                    await confirmLibraryNodeDelete(libraryCommandScope, nodeIds[0])
                } else {
                    await libraryCommandScope.execute("library.selection.delete", {
                        nodeIds,
                        confirmed: true,
                    })
                }
            }}
            onCancel={() => {
                libraryUI.isDeleteModalOpen = false
                libraryUI.nodesToDeleteIds = []
            }}
        />
    {/if}

    {#each libraryUI.metadataEditorNodeIds as nodeId (nodeId)}
        {#if vfsStore.nodes[nodeId]?.type === "file"}
            <EditBookMetadataModal {nodeId} />
        {/if}
    {/each}

    {#if libraryUI.isRenameFolderModalOpen && libraryUI.folderToRenameId}
        <RenameFolderModal nodeId={libraryUI.folderToRenameId} />
    {/if}

    {#if libraryUI.isPickingMode}
        <PickerModeKeymaps
            {currentNodes}
            {currentHints}
            bind:keyBuffer={pickerKeyBuffer}
            onSelect={handlePickerSelect}
        />
    {/if}

    <main class:selection-mode={libraryUI.isSelectionMode} onfocusin={handleCardFocus}>
        {#if displayEntries.length !== 0 || vfsStore.currentFolderId !== null}
            <ul class="card_list grid" style:--library-card-min={`${libraryUI.cardSizeRem}rem`}>
                {#each displayEntries as entry (entry.id)}
                    <li class="card_item">
                        <Card
                            class="card_inner"
                            node={entry.node}
                            importJob={entry.job}
                            data-id={entry.id}
                            Icon={BookIcon}
                            onclick={entry.interactive && entry.node
                                ? (e) => handleNodeClick(e, entry.node!)
                                : undefined}
                        />
                        {#if libraryUI.isPickingMode && entry.interactive && entry.node}
                            {@const idx = interactiveIndex.get(entry.node.id)}
                            {@const hint = idx === undefined ? undefined : currentHints[idx]}
                            {#if hint && hint.startsWith(pickerKeyBuffer)}
                                <PickerKey
                                    onSelect={() => handlePickerSelect(entry.node!)}
                                    keyChar={hint.slice(pickerKeyBuffer.length)}
                                />
                            {/if}
                        {/if}
                    </li>
                {/each}
            </ul>
        {:else}
            <BookImporter />
        {/if}
    </main>

    {#if libraryUI.isSelectionMode}
        <div class="selection-bar">
            <div class="selection-actions">
                <Button
                    variant="brutalist"
                    size="small"
                    Icon={allSelected ? MinusIcon : CheckIcon}
                    onclick={() =>
                        void libraryCommandScope.execute(
                            allSelected ? "library.selection.clear" : "library.selection.all",
                        )}
                >
                    <span>{allSelected ? m.deselect_all() : m.select_all()}</span>
                </Button>
                <Button
                    variant="brutalist"
                    size="small"
                    onclick={() => void toggleSelectedPinned()}
                    disabled={selectedNodes.length === 0}
                    aria-label={allSelectedPinned ? m.unpin() : m.pin()}
                    tooltip={allSelectedPinned ? m.unpin() : m.pin()}
                >
                    <PinIcon />
                    <span>{allSelectedPinned ? m.unpin() : m.pin()}</span>
                </Button>
                <Button
                    variant="brutalist"
                    size="small"
                    onclick={() => void toggleSelectedReadState()}
                    disabled={selectedBooks.length === 0}
                    aria-label={allSelectedBooksRead ? m.mark_as_unread() : m.mark_as_read()}
                    tooltip={allSelectedBooksRead ? m.mark_as_unread() : m.mark_as_read()}
                >
                    {#if allSelectedBooksRead}
                        <BookOpenIcon />
                    {:else}
                        <CheckCircleIcon />
                    {/if}
                    <span>{allSelectedBooksRead ? m.mark_as_unread() : m.mark_as_read()}</span>
                </Button>
                <Button
                    variant="brutalist"
                    size="small"
                    onclick={() => void libraryCommandScope.execute("library.selection.move")}
                    disabled={vfsStore.selectedIds.size === 0}
                >
                    <NavigationIcon />
                    <span>{m.move()}</span>
                </Button>
                <Button
                    variant="brutalist"
                    size="small"
                    class="danger-btn"
                    onclick={() => void libraryCommandScope.execute("library.selection.delete")}
                    disabled={vfsStore.selectedIds.size === 0}
                >
                    <TrashIcon />
                    <span>{m.delete_selected()}</span>
                </Button>
            </div>
        </div>
    {/if}

    {#if viewport.isCompact && !libraryUI.isSelectionMode}
        <div class="mobile-controls-container">
            <button
                class="mobile-prompt-btn"
                onclick={() => void executeLibraryHostCommand("prompt.open")}
                aria-label={m.keymap_prompt()}
                title={m.keymap_prompt()}
            >
                <TerminalIcon />
            </button>
        </div>
    {/if}
</div>

<style>
    .cleanup-status {
        padding: 1rem;
        margin-block: 1rem;
        border: 1px solid var(--border-color);
        border-radius: var(--radius-lg, 1rem);
        background: var(--bg-secondary);
    }

    .container {
        max-inline-size: 1280px;
        margin-block: 0;
        margin-inline: auto;
        inline-size: 100%;
        display: flex;
        flex-direction: column;
        padding-block-end: 64px;
    }

    .library-actions {
        display: flex;
        align-items: center;
        gap: var(--space-2);
        margin-block-end: var(--space-5);
        font-family: var(--ui-font);
    }

    .library-actions :global(.button) {
        min-block-size: var(--control-height-regular);
    }

    .card_list {
        padding: 0;
        margin: 0;
        list-style: none;
    }

    .card_item {
        position: relative;
        scroll-margin-block-end: 120px;
    }

    :global(.card_inner) {
        min-inline-size: 100%;
        min-block-size: 100%;
    }

    .grid {
        display: grid;
        grid-template-columns: repeat(
            auto-fill,
            minmax(min(100%, var(--library-card-min, 11rem)), 1fr)
        );
        gap: var(--space-5);
    }

    main.selection-mode .grid {
        pointer-events: auto;
    }

    @media (--mobile-width) {
        .library-actions {
            display: grid;
            grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
        }

        .library-actions :global(.import-action),
        .library-actions :global(.button) {
            inline-size: 100%;
            min-inline-size: 0;
            padding-inline: var(--space-2);
        }

        .grid {
            grid-template-columns: repeat(2, minmax(0, 1fr));
            gap: var(--space-4);
        }
    }

    @media (--phone) {
        .library-actions {
            grid-template-columns: 1fr;
        }

        .grid {
            grid-template-columns: minmax(0, 1fr);
            gap: var(--space-3);
        }
    }

    .selection-bar {
        position: fixed;
        bottom: 24px;
        left: 50%;
        transform: translateX(-50%);
        padding: var(--space-2) var(--space-3);
        display: flex;
        align-items: center;
        z-index: var(--z-modal);
        max-inline-size: 90dvw;
        box-sizing: border-box;
        background: var(--surface-color);
        border: 1px solid var(--color-rule);
        border-radius: 999px;
    }

    .selection-actions {
        display: flex;
        align-items: stretch;
        gap: var(--space-2);
        flex: 1;
        justify-content: center;
    }

    .selection-actions :global(.button) {
        block-size: auto;
        align-self: stretch;
    }

    :global(.danger-btn) {
        color: var(--danger-active-color) !important;
    }

    @media (--mobile-width) {
        .selection-bar {
            bottom: 16px;
            padding: var(--space-2) var(--space-4);
            gap: var(--space-2);
            min-inline-size: auto;
            flex-direction: row;
            align-items: center;
        }

        .selection-actions {
            justify-content: flex-end;
            flex-wrap: nowrap;
        }

        .selection-actions :global(.button span) {
            display: none;
        }

        .selection-actions :global(.button) {
            width: 36px;
            height: 36px;
            padding: 0;
            justify-content: center;
        }
    }

    .mobile-controls-container {
        position: fixed;
        bottom: calc(16px + env(safe-area-inset-bottom));
        left: 50%;
        transform: translateX(-50%);
        display: flex;
        align-items: center;
        gap: var(--space-4);
        z-index: var(--z-sticky);
    }

    .mobile-prompt-btn {
        width: 44px;
        height: 44px;
        background: var(--surface-color);
        border: 1px solid var(--color-rule);
        border-radius: var(--radius-full);
        display: flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        color: var(--text-color);
        padding: 0;
        transition:
            transform 0.1s ease,
            box-shadow 0.1s ease,
            background-color 0.12s ease;
    }

    .mobile-prompt-btn:active {
        transform: translate(1px, 1px);
        box-shadow: 0 0 0 var(--shadow-color);
        background: var(--surface-hover-color);
    }

    .mobile-prompt-btn :global(svg) {
        width: 18px;
        height: 18px;
    }
</style>
