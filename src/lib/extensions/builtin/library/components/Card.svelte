<script lang="ts">
    import { useLibraryUI } from "../state/libraryUI.svelte"
    import { type Component } from "svelte"
    import type { HTMLButtonAttributes } from "svelte/elements"
    import * as m from "$lib/paraglide/messages"
    import BookOpenIcon from "$lib/shared/icons/BookOpenIcon.svelte"
    import CheckCircleIcon from "$lib/shared/icons/CheckCircleIcon.svelte"
    import { vfsStore, usePreviewUrl } from "../state/libraryStore.svelte"
    import type { VFSNode, FileNode, ImportJob } from "../state/libraryStore.svelte"
    import TrashIcon from "$lib/shared/icons/TrashIcon.svelte"
    import NavigationIcon from "$lib/shared/icons/NavigationIcon.svelte"
    import MoreVerticalIcon from "$lib/shared/icons/MoreVerticalIcon.svelte"
    import PinIcon from "$lib/shared/icons/PinIcon.svelte"
    import FolderIcon from "$lib/shared/icons/FolderIcon.svelte"
    import CheckIcon from "$lib/shared/icons/CheckIcon.svelte"
    import EditIcon from "$lib/shared/icons/EditIcon.svelte"
    import Button from "$lib/shared/ui/Button.svelte"
    import Dropdown from "$lib/shared/ui/Dropdown.svelte"
    import {
        commandsStore,
        getShortcutHint,
        type CommandScope,
    } from "../commands/commandsStore.svelte"
    import { useLibraryCardCommands } from "../commands/useLibraryCardCommands.svelte"
    import { requestLibraryNodeDelete } from "../commands/libraryNodeExecution"
    import { settingsStore } from "../state/librarySettings"
    import { resolveBookTitle } from "../utils/bookTitle"
    import { formatBookProgress } from "../utils/bookProgress"
    import { executeLibraryHostCommand } from "../state/libraryHostBridge"

    const libraryUI = useLibraryUI()

    interface Props extends HTMLButtonAttributes {
        node?: VFSNode
        name?: string
        isPlaceholder?: boolean
        importJob?: ImportJob
        Icon?: Component
        class?: string
        onclick?: (e: MouseEvent) => void | Promise<void>
    }

    let {
        node,
        name = "",
        isPlaceholder: legacyPlaceholder = false,
        importJob,
        Icon,
        class: className,
        onclick,
        ...props
    }: Props = $props()
    const isPlaceholder = $derived(legacyPlaceholder || !!importJob)
    const isFailed = $derived(importJob?.stage === "failed")
    const isLoading = $derived(isPlaceholder && !isFailed)

    let isRestoring = $state(false)
    let showMenu = $state(false)
    let longPressTimeout: ReturnType<typeof setTimeout> | undefined

    let commandsNode = $state.raw<CommandScope>(undefined as any)
    commandsNode = useLibraryCardCommands({
        getNodeId: () => node?.id,
        isExecutable: () => !isPlaceholder && !isRestoring,
        isSelected: () => (node ? vfsStore.selectedIds.has(node.id) : false),
        isPinned: () => !!node?.isPinned,
        isRead: () =>
            !!(
                node &&
                node.type === "file" &&
                node.metadata.totalPages !== undefined &&
                node.metadata.totalPages > 0 &&
                (node.metadata.pageNumber || 1) === node.metadata.totalPages
            ),
        canToggleReadState: () => node?.type === "file",
        canEditMetadata: () => node?.type === "file",
        canRenameFolder: () => node?.type === "folder",
        setMenuOpen: (open: boolean) => {
            showMenu = open
        },
        openNode: async ({ nodeId }) => {
            if (!nodeId) return
            const target = vfsStore.nodes[nodeId]
            if (target?.type === "folder") {
                await commandsNode.parent?.execute("library.folder.open", {
                    folderId: nodeId,
                })
            } else {
                await executeLibraryHostCommand("viewer.open", { bookId: nodeId })
            }
        },
        toggleSelection: async (payload) => {
            await commandsNode.parent?.execute("library.selection.toggle", payload)
        },
        moveNode: async (payload) => {
            await commandsNode.parent?.execute("library.node.move", payload)
        },
        togglePinned: async (payload) => {
            await commandsNode.parent?.execute("library.node.pin.toggle", payload)
        },
        deleteNode: async (payload) => {
            await commandsNode.parent?.execute("library.node.delete", payload)
        },
        editMetadata: async (payload) => {
            await commandsNode.parent?.execute("library.node.edit-metadata", payload)
        },
        renameFolder: async (payload) => {
            await commandsNode.parent?.execute("library.node.rename", payload)
        },
        toggleReadState: async (payload) => {
            await commandsNode.parent?.execute("library.book.read-state.toggle", payload)
        },
        relink: async (payload) => {
            await commandsNode.parent?.execute("library.node.relink", payload)
        },
    })

    const handleFocus = () => {
        if (showMenu) return
        if (libraryUI.isPickingMode) return
        commandsStore.activate(commandsNode)
    }

    const handleFocusOut = (e: FocusEvent) => {
        const currentTarget = e.currentTarget as HTMLElement
        const relatedTarget = e.relatedTarget as HTMLElement | null
        if (currentTarget && relatedTarget && currentTarget.contains(relatedTarget)) {
            return
        }
        if (commandsStore.activeScope === commandsNode) {
            commandsStore.deactivate(commandsNode)
        }
    }

    const isSelected = $derived(node ? vfsStore.selectedIds.has(node.id) : false)
    const isPinned = $derived(!!node?.isPinned)
    const kind = $derived.by(() => {
        if (isPlaceholder || node?.type === "file") return "book"
        return "folder"
    })
    const extension = $derived(kind === "book" ? "pdf" : undefined)

    const preview = usePreviewUrl(() =>
        node && node.type === "file" && !isPlaceholder ? node.id : "",
    )
    const previewUrl = $derived(preview ? preview.url : "")

    const fileNode = $derived(node && node.type === "file" ? (node as FileNode) : null)

    const book = $derived.by(() => {
        if (fileNode) {
            return {
                id: fileNode.id,
                name: resolveBookTitle(fileNode, settingsStore.preferPdfTitle),
                updatedAt: fileNode.updatedAt,
                pageNumber: fileNode.metadata.pageNumber,
                totalPages: fileNode.metadata.totalPages,
                author: fileNode.metadata.author,
                previewDataUrl: previewUrl,
                isLocked: vfsStore.isLockedMap[fileNode.id],
            }
        }
        return null
    })

    let pageProgress = $derived(
        book
            ? formatBookProgress(book.pageNumber, book.totalPages, (total) => m.of_pages({ total }))
            : undefined,
    )

    let progressPercent = $derived.by(() => {
        if (
            !isPlaceholder &&
            fileNode &&
            fileNode.metadata.totalPages &&
            fileNode.metadata.totalPages > 0
        ) {
            const page = fileNode.metadata.pageNumber || 1
            const total = fileNode.metadata.totalPages
            return Math.min(100, Math.max(0, Math.round((page / total) * 100)))
        }
        return 0
    })

    const handleClick = async (e: MouseEvent) => {
        if (isPlaceholder || isRestoring) return
        const target = e.target as HTMLElement | null
        if (target && target.closest(".card-menu")) return
        if (onclick) {
            isRestoring = true
            try {
                await onclick(e)
            } finally {
                isRestoring = false
            }
        }
    }

    const onPointerDown = () => {
        if (!node || libraryUI.isSelectionMode) return
        longPressTimeout = setTimeout(() => {
            if (node) {
                void commandsNode.execute("library.selection.toggle", { nodeId: node.id })
                if (navigator.vibrate) navigator.vibrate(50)
            }
        }, 500)
    }

    const onPointerUp = () => {
        clearTimeout(longPressTimeout)
    }

    const handleImageError = async () => {
        if (!node) return
        console.warn(
            `[Card] Preview image failed to load for node ${node.id}, attempting to regenerate...`,
        )
        if (preview) await preview.regenerate()
    }

    const onRemove = (event: MouseEvent) => {
        event.stopPropagation()
        if (node) void requestLibraryNodeDelete(node.id)
    }

    const onMove = (event: MouseEvent) => {
        event.stopPropagation()
        if (node) void commandsNode.execute("library.node.move", { nodeId: node.id })
    }

    const onPin = (event: MouseEvent) => {
        event.stopPropagation()
        if (!node) return
        void commandsNode.execute("library.node.pin.toggle", {
            nodeId: node.id,
            isPinned: !isPinned,
        })
    }

    const onSelect = (event: MouseEvent) => {
        event.stopPropagation()
        if (!node) return
        void commandsNode.execute("library.selection.toggle", { nodeId: node.id })
    }

    const onRename = (event: MouseEvent) => {
        event.stopPropagation()
        if (!node || node.type !== "folder") return
        void commandsNode.execute("library.node.rename", { nodeId: node.id })
    }

    const onEditMetadata = (event: MouseEvent) => {
        event.stopPropagation()
        if (!node) return
        void commandsNode.execute("library.node.edit-metadata", { nodeId: node.id })
    }

    const isRead = $derived(
        fileNode &&
            fileNode.metadata.totalPages !== undefined &&
            fileNode.metadata.totalPages > 0 &&
            (fileNode.metadata.pageNumber || 1) === fileNode.metadata.totalPages,
    )

    const toggleReadState = (event: MouseEvent) => {
        event.stopPropagation()
        if (!fileNode) return
        void commandsNode.execute("library.book.read-state.toggle", {
            nodeId: fileNode.id,
            markAsRead: !isRead,
        })
    }

    const closeMenu = () => {
        showMenu = false
    }

    const handleMouseLeave = () => {
        if (window.matchMedia("(hover: hover)").matches) {
            closeMenu()
        }
    }

    const ariaLabel = $derived.by(() => {
        const importName = importJob?.name ?? name
        if (isLoading) return `${m.book_metadata_loading()}: ${importName}`
        if (isFailed) return m.book_import_failed({ name: importName })
        return undefined
    })
</script>

<div
    class="card-shell"
    class:is-selected={isSelected}
    class:menu-open={showMenu}
    role="group"
    aria-label={`${book?.name ?? node?.name ?? importJob?.name ?? name}${isPinned ? `, ${m.pinned()}` : ""}${isSelected ? `, ${m.selected_label()}` : ""}`}
    onmouseleave={handleMouseLeave}
    onfocusin={handleFocus}
    onfocusout={handleFocusOut}
>
    <button
        type="button"
        aria-label={ariaLabel}
        aria-busy={isLoading ? "true" : undefined}
        disabled={isPlaceholder || isRestoring}
        class={`card ${className}`}
        class:is-selected={isSelected}
        class:is-placeholder={isPlaceholder}
        onpointerdown={isPlaceholder ? null : onPointerDown}
        onpointerup={isPlaceholder ? null : onPointerUp}
        onpointercancel={isPlaceholder ? null : onPointerUp}
        onclick={handleClick}
        {...props}
    >
        <div class="card-cover-container">
            {#if kind === "book" && extension}
                <div class="badge" aria-label="{m.file_format()}: {extension}">
                    {extension}
                </div>
            {/if}

            {#if isSelected}
                <div class="selection-badge">
                    <CheckIcon />
                </div>
            {/if}

            {#if isLoading}
                <div class="cover-skeleton skeleton" aria-hidden="true"></div>
            {:else if isFailed}
                <div class="card-icon failed-icon" aria-hidden="true">
                    {#if Icon}<Icon />{/if}
                </div>
            {:else if book && book.previewDataUrl}
                <div class="card-preview" aria-hidden="true">
                    <div class="pdf-image-wrapper">
                        <img
                            src={book.previewDataUrl}
                            alt={m.cover_preview_alt()}
                            onerror={handleImageError}
                        />
                    </div>
                </div>
            {:else}
                <div class="card-icon" aria-hidden="true">
                    {#if kind === "folder"}
                        <FolderIcon />
                    {:else if Icon}
                        <Icon />
                    {/if}
                </div>
            {/if}

            {#if kind === "book" && book && book.totalPages && book.totalPages > 0}
                <div class="progress-container">
                    <div class="progress-bar-track">
                        <div
                            class="progress-bar-fill"
                            class:has-border={progressPercent > 0 && progressPercent < 100}
                            style="width: {progressPercent}%"
                        ></div>
                    </div>
                    <span class="progress-text">{progressPercent}%</span>
                </div>
            {/if}
        </div>

        <div class="card-metadata">
            <p class="card-title">{book?.name ?? importJob?.name ?? node?.name ?? name}</p>
            {#if kind === "book"}
                {#if isLoading && !book?.author}
                    <div class="metadata-skeleton skeleton" aria-hidden="true"></div>
                {:else}
                    <p class="card-author">
                        {#if isFailed}
                            {m.book_import_failed({ name: importJob?.name ?? name })}
                        {:else if book?.author}
                            {book.author}
                        {:else}
                            {m.unknown_author()}
                        {/if}
                        {#if pageProgress}
                            · {pageProgress}
                        {/if}
                    </p>
                {/if}
            {/if}
        </div>
    </button>

    {#if isPinned}
        <div class="pin-marker" aria-hidden="true">
            <PinIcon />
        </div>
    {/if}

    {#if !isPlaceholder && !libraryUI.isSelectionMode && (kind === "book" || kind === "folder")}
        <div class="card-menu">
            <Dropdown align="right" bind:isOpen={showMenu}>
                {#snippet trigger(props)}
                    <Button
                        {...props}
                        variant="fab"
                        square={true}
                        size="large"
                        class="menu-btn"
                        aria-label={m.more_options()}
                        tooltip={`${m.more_options()}${getShortcutHint(commandsNode, "library.card.menu.toggle")}`}
                        onpointerdown={(e) => e.stopPropagation()}
                    >
                        <MoreVerticalIcon />
                    </Button>
                {/snippet}

                <Button variant="none" class="dropdown-item" role="menuitem" onclick={onSelect}>
                    <CheckIcon class="dropdown-icon" />
                    <span>{m.select()}</span>
                </Button>
                <Button variant="none" class="dropdown-item" role="menuitem" onclick={onMove}>
                    <NavigationIcon class="dropdown-icon" />
                    <span>{m.move()}</span>
                </Button>
                <Button variant="none" class="dropdown-item" role="menuitem" onclick={onPin}>
                    <PinIcon class="dropdown-icon" />
                    <span>{isPinned ? m.unpin() : m.pin()}</span>
                </Button>
                {#if kind === "folder"}
                    <Button variant="none" class="dropdown-item" role="menuitem" onclick={onRename}>
                        <EditIcon class="dropdown-icon" />
                        <span>{m.rename()}</span>
                    </Button>
                {/if}
                {#if kind === "book"}
                    <Button
                        variant="none"
                        class="dropdown-item"
                        role="menuitem"
                        onclick={toggleReadState}
                    >
                        {#if isRead}
                            <BookOpenIcon class="dropdown-icon" />
                            <span>{m.mark_as_unread()}</span>
                        {:else}
                            <CheckCircleIcon class="dropdown-icon" />
                            <span>{m.mark_as_read()}</span>
                        {/if}
                    </Button>
                    <Button
                        variant="none"
                        class="dropdown-item"
                        role="menuitem"
                        onclick={onEditMetadata}
                    >
                        <EditIcon class="dropdown-icon" />
                        <span>{m.edit_metadata()}</span>
                    </Button>
                {/if}
                <Button variant="none" class="dropdown-item" role="menuitem" onclick={onRemove}>
                    <TrashIcon class="dropdown-icon" />
                    <span>
                        {kind === "book"
                            ? m.remove_book
                                ? m.remove_book()
                                : "Remove book"
                            : m.remove_folder
                              ? m.remove_folder()
                              : "Remove folder"}
                    </span>
                </Button>
            </Dropdown>
        </div>
    {/if}
</div>

<style>
    .card-shell {
        position: relative;
        z-index: var(--z-base);
        width: 100%;
        height: 100%;
    }
    .card-shell.menu-open {
        z-index: var(--z-dropdown);
    }
    .card {
        background: var(--surface-color);
        border: 1px solid transparent;
        border-radius: var(--radius-md);
        box-sizing: border-box;
        display: flex;
        flex-direction: column;
        width: 100%;
        height: 100%;
        padding: 0;
        cursor: pointer;
        font-family: inherit;
        text-align: left;
        color: inherit;
        align-items: stretch;
        overflow: hidden;
        user-select: none;
        -webkit-touch-callout: none;
        transition:
            background-color 120ms ease,
            border-color 120ms ease;
    }
    .card.is-selected {
        border-color: var(--selection-color);
        background: var(--selected-surface);
    }
    @media (hover: hover) {
        .card:hover:not(.is-placeholder) {
            background: var(--surface-hover-color);
        }
    }
    .card:focus-visible:not(.is-placeholder) {
        outline: 2px solid var(--focus-color);
        outline-offset: 3px;
    }
    .card:active:not(.is-placeholder) {
        border-color: var(--color-control-border);
    }
    .card-cover-container {
        position: relative;
        width: 100%;
        aspect-ratio: 2 / 3;
        background: var(--color-surface-raised);
        overflow: hidden;
        display: flex;
        align-items: center;
        justify-content: center;
    }
    .card-icon,
    .card-preview,
    .pdf-image-wrapper {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 100%;
        height: 100%;
    }
    .card-icon {
        color: var(--faded-text-color);
    }
    .card-icon :global(svg) {
        width: 40px;
        height: 40px;
        stroke-width: 1.5;
    }
    .card-preview img {
        width: 100%;
        height: 100%;
        object-fit: cover;
        display: block;
    }
    .card-metadata {
        width: 100%;
        min-height: 88px;
        display: flex;
        flex-direction: column;
        justify-content: center;
        gap: 6px;
        padding: 16px;
        box-sizing: border-box;
    }
    .card-title {
        margin: 0;
        font-size: var(--font-size-base);
        font-weight: 500;
        line-height: 1.4;
        overflow-wrap: anywhere;
        display: -webkit-box;
        -webkit-line-clamp: 2;
        line-clamp: 2;
        -webkit-box-orient: vertical;
        overflow: hidden;
    }
    .card-author {
        margin: 0;
        font-size: var(--font-size-sm);
        color: var(--faded-text-color);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        line-height: 1.5;
    }
    .badge,
    .pin-marker,
    .selection-badge {
        position: absolute;
        z-index: var(--z-10);
        display: grid;
        place-items: center;
        background: var(--surface-color);
        color: var(--text-color);
        border-radius: var(--radius-sm);
        pointer-events: none;
    }
    .badge {
        top: 12px;
        left: 12px;
        padding: 4px 8px;
        font-size: var(--font-size-xs);
    }
    .pin-marker {
        right: 12px;
        bottom: 12px;
        width: 24px;
        height: 24px;
    }
    .pin-marker :global(svg) {
        width: 14px;
        height: 14px;
    }
    .selection-badge {
        top: 12px;
        right: 12px;
        width: 28px;
        height: 28px;
        background: var(--selection-color);
        color: var(--selection-text-color);
    }
    .selection-badge :global(svg) {
        width: 18px;
        height: 18px;
    }
    .card-menu {
        position: absolute;
        top: 8px;
        right: 8px;
        z-index: var(--z-20);
    }
    :global(.menu-btn) {
        opacity: 0;
        pointer-events: none;
        background: var(--surface-color) !important;
    }
    :global(.menu-btn.open),
    .card-shell:hover :global(.menu-btn),
    .card-shell:focus-within :global(.menu-btn) {
        opacity: 1;
        pointer-events: auto;
    }
    .progress-container {
        position: absolute;
        bottom: 0;
        left: 0;
        width: 100%;
        height: 28px;
        background: var(--surface-color);
        box-sizing: border-box;
        overflow: hidden;
        z-index: var(--z-5);
    }
    .progress-bar-track {
        width: 100%;
        height: 100%;
        position: relative;
    }
    .progress-bar-fill {
        position: absolute;
        bottom: 0;
        height: 3px;
        background: var(--progress-color);
    }
    .progress-bar-fill.has-border {
        border: 0;
    }
    .progress-text {
        position: absolute;
        inset: 0 0 3px;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: var(--font-size-xs);
        font-variant-numeric: tabular-nums;
        color: var(--faded-text-color);
        pointer-events: none;
    }
    .card.is-placeholder {
        cursor: wait;
    }
    .skeleton {
        background: var(--surface-hover-color);
        border-radius: var(--radius-sm);
    }
    .cover-skeleton {
        width: 100%;
        height: 100%;
    }
    .metadata-skeleton {
        width: 62%;
        height: 0.7rem;
    }
    .failed-icon {
        color: var(--danger-active-color);
    }
    @media (hover: none), (pointer: coarse) {
        :global(.menu-btn) {
            opacity: 1;
            pointer-events: auto;
        }
    }
    @media (--phone) {
        .card-shell {
            min-height: 124px;
        }
        .card {
            display: grid;
            grid-template-columns: 80px minmax(0, 1fr);
            grid-template-rows: minmax(124px, auto);
        }
        .card-cover-container {
            width: 80px;
            height: 124px;
            aspect-ratio: auto;
        }
        .card-metadata {
            padding: 16px 48px 32px 16px;
        }
        .progress-container {
            /* Progress lives inside the clipped cover, not the metadata column. */
            left: 0;
            width: 100%;
            height: 24px;
        }
        .badge {
            top: 8px;
            left: 8px;
            padding: 2px 4px;
        }
        .pin-marker {
            top: 10px;
            right: 56px;
            bottom: auto;
        }
        .card-icon :global(svg) {
            width: 28px;
            height: 28px;
        }
    }
</style>
