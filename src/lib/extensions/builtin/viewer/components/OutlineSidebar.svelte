<script lang="ts">
    import { viewport } from "$lib/shared/state/viewport.svelte"
    import * as m from "$lib/paraglide/messages"
    import Spinner from "$lib/shared/ui/Spinner.svelte"
    import { SidebarFooter, SidebarSearch } from "$lib/shared/ui/sidebar"
    import type { DocumentOutlineEntry } from "$lib/document-model"
    import { KeyboardHandler, commandsStore, useCommands } from "$lib/core/commands"
    import { createViewerOutlineCommands } from "../commands/viewerOutlineCommands"
    import { MediaQuery } from "svelte/reactivity"
    import Button from "$lib/shared/ui/Button.svelte"
    import { modalManager } from "$lib/shared/ui/modal/modalManager.svelte"
    import { resolveSelectionIndex } from "$lib/shared/state/listSelection"
    import { notesStore } from "../stores/notesStore.svelte"
    import { tick, untrack } from "svelte"
    import { buildSidebarNavigationHints, findSidebarShortcut } from "./sidebarShortcutHints"

    let {
        isOutlineLoading,
        outlineList,
        currentPage = $bindable(),
        scrollPosition = $bindable(),
        activeHeadings,
        onClose,
        interactive = true,
    } = $props<{
        isOutlineLoading: boolean
        outlineList: DocumentOutlineEntry[] | null
        currentPage: number
        scrollPosition: number
        activeHeadings: Set<DocumentOutlineEntry>
        onClose: () => void
        interactive?: boolean
    }>()

    let searchQuery = $state("")
    let manualSelectedIndex = $state<number | null>(null)
    const phoneQuery = new MediaQuery("(max-width: 480px)")
    let searchInputRef = $state<HTMLInputElement | null>(null)
    let isSearchFocused = $state(false)

    let normalizedSearchQuery = $derived(searchQuery.toLowerCase())
    let filteredOutlineList = $derived(
        outlineList?.filter((heading: DocumentOutlineEntry) =>
            heading.title.toLowerCase().includes(normalizedSearchQuery),
        ) ?? [],
    )

    async function selectHeading(heading: DocumentOutlineEntry) {
        if (heading.pageNumber === undefined) return

        if (window.innerWidth <= 480) {
            onClose()
            // Commit the closed sidebar before pushState snapshots the current history entry.
            await tick()
        }

        void commandsStore.execute("viewer.page.go-to", {
            page: heading.pageNumber,
            isJump: true,
        })
    }

    let selectedIndex = $derived.by(() => {
        const activeIndex = filteredOutlineList.findIndex((heading: DocumentOutlineEntry) =>
            activeHeadings.has(heading),
        )
        let automaticIndex = activeIndex
        if (phoneQuery.current) {
            automaticIndex = -1
        } else if (searchQuery || activeIndex === -1) {
            automaticIndex = 0
        }

        return resolveSelectionIndex(
            manualSelectedIndex,
            filteredOutlineList.length,
            automaticIndex,
        )
    })

    function navigateSelection(direction: "next" | "prev") {
        if (filteredOutlineList.length === 0) return
        manualSelectedIndex =
            direction === "next"
                ? (selectedIndex + 1) % filteredOutlineList.length
                : (selectedIndex - 1 + filteredOutlineList.length) % filteredOutlineList.length
        scrollSelectedIntoView()
    }

    function handleSearchKeydown(event: KeyboardEvent) {
        if (event.key === "Enter") {
            event.preventDefault()
            const heading = filteredOutlineList[selectedIndex]
            if (heading) {
                selectHeading(heading)
                onClose()
            }
        }
    }

    function scrollSelectedIntoView() {
        requestAnimationFrame(() => {
            if (!contentRef) return
            contentRef.querySelector(".outline-item.selected")?.scrollIntoView({ block: "nearest" })
        })
    }

    function resetSelection() {
        manualSelectedIndex = null
    }

    function isEditableTarget(target: EventTarget | null) {
        return (
            target instanceof HTMLInputElement ||
            target instanceof HTMLTextAreaElement ||
            (target instanceof HTMLElement && target.isContentEditable)
        )
    }

    const outlineCommandScope = useCommands(
        createViewerOutlineCommands({
            nextLabel: () => m.keymap_next_heading(),
            // English callbacks feed keyboard-help search without replacing localized labels.
            nextEnglishLabel: () => m.keymap_next_heading({}, { locale: "en" }),
            previousLabel: () => m.keymap_prev_heading(),
            previousEnglishLabel: () => m.keymap_prev_heading({}, { locale: "en" }),
            selectLabel: () => m.keymap_select_heading(),
            selectEnglishLabel: () => m.keymap_select_heading({}, { locale: "en" }),
            searchLabel: () => m.keymap_search_headings(),
            searchEnglishLabel: () => m.keymap_search_headings({}, { locale: "en" }),
            disabled: () =>
                !interactive || modalManager.hasBlockingModal || !!notesStore.activePopup,
            shouldHandleNavigationKey: (event) =>
                !(
                    isEditableTarget(event.target) &&
                    (KeyboardHandler.matches(event, "j") || KeyboardHandler.matches(event, "k"))
                ),
            next: () => navigateSelection("next"),
            previous: () => navigateSelection("prev"),
            select: () => {
                const heading = filteredOutlineList[selectedIndex]
                if (heading) {
                    selectHeading(heading)
                    onClose()
                }
            },
            search: () => {
                searchInputRef?.focus()
                searchInputRef?.select()
            },
        }),
        undefined,
        { autoActivate: untrack(() => interactive) },
    )

    let navigateShortcuts = $derived(
        buildSidebarNavigationHints(
            outlineCommandScope.getShortcut("viewer.outline.next"),
            outlineCommandScope.getShortcut("viewer.outline.previous"),
            isSearchFocused,
        ),
    )
    let selectShortcut = $derived(
        findSidebarShortcut(outlineCommandScope.getShortcut("viewer.outline.select"), "enter"),
    )
    let searchShortcut = $derived(
        findSidebarShortcut(outlineCommandScope.getShortcut("viewer.outline.search"), "/"),
    )
    let closeShortcut = $derived(
        findSidebarShortcut(outlineCommandScope.getShortcut("viewer.sidebar.close"), "escape"),
    )

    let contentRef: HTMLElement | undefined = $state()
    let hasScrolledInitially = false

    function trackOutlineSelection(
        _index: number,
        _items: DocumentOutlineEntry[],
        loading: boolean,
    ) {
        return (content: HTMLElement) => {
            contentRef = content
            const frame = requestAnimationFrame(() => {
                if (!hasScrolledInitially && !loading) {
                    const activeElements = content.querySelectorAll(".outline-item.active")
                    activeElements.item(activeElements.length - 1)?.scrollIntoView({
                        block: "center",
                    })
                    hasScrolledInitially = true
                    return
                }
                content
                    .querySelector(".outline-item.selected")
                    ?.scrollIntoView({ block: "nearest" })
            })
            return () => {
                if (contentRef === content) contentRef = undefined
                cancelAnimationFrame(frame)
            }
        }
    }
</script>

{#if outlineList && outlineList.length > 0}
    <SidebarSearch
        bind:ref={searchInputRef}
        bind:value={searchQuery}
        oninput={resetSelection}
        onClear={resetSelection}
        placeholder={m.search_headings_placeholder()}
        onkeydown={handleSearchKeydown}
        bind:focused={isSearchFocused}
        clearLabel={m.clear_search_aria()}
    />
{/if}

<div
    class="sidebar-content"
    {@attach trackOutlineSelection(selectedIndex, filteredOutlineList, isOutlineLoading)}
>
    {#if isOutlineLoading}
        <div class="outline-loader">
            <Spinner variant="dots" size="sm" label="" />
        </div>
    {:else if !outlineList || outlineList.length === 0}
        <div class="no-outline">
            {m.no_outline()}
        </div>
    {:else if filteredOutlineList.length === 0}
        <div class="no-outline no-outline-actions">
            <span>{m.no_matching_headings()}</span>
            <Button
                variant="ghost"
                size="small"
                onclick={() => {
                    searchQuery = ""
                    resetSelection()
                    searchInputRef?.focus()
                }}
                aria-label={m.clear_search_aria()}
            >
                {m.clear_search_aria()}
            </Button>
        </div>
    {:else}
        <nav class="outline-nav">
            {#each filteredOutlineList as heading, index (heading)}
                <Button
                    variant="none"
                    size="none"
                    class={`outline-item depth-${heading.depth}${activeHeadings.has(heading) ? " active" : ""}${index === selectedIndex ? " selected" : ""}`}
                    onclick={() => {
                        selectHeading(heading)
                        manualSelectedIndex = index
                    }}
                    disabled={heading.pageNumber === undefined}
                    style="--depth: {heading.depth}"
                    title={heading.title}
                >
                    <span class="heading-title">{heading.title}</span>
                    {#if heading.pageNumber !== undefined}
                        <span class="heading-page">{heading.pageNumber}</span>
                    {/if}
                </Button>
            {/each}
        </nav>
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
    </SidebarFooter>
{/if}

<style>
    .sidebar-content {
        flex: 1;
        box-sizing: border-box;
        overflow-y: auto;
        padding-bottom: var(--sidebar-safe-area-end, 0px);
        background: transparent;
        overscroll-behavior: contain;
    }

    .outline-loader {
        display: flex;
        align-items: center;
        justify-content: center;
        height: 100px;
    }

    .no-outline {
        padding: 24px;
        text-align: center;
        font-size: var(--font-size-md);
        font-weight: 700;
        color: var(--faded-text-color);
    }

    .no-outline-actions {
        display: grid;
        justify-items: center;
        gap: 12px;
    }

    .outline-nav {
        display: flex;
        flex-direction: column;
        padding: 8px 0;
    }

    .outline-nav :global(.tooltip-align-left) {
        margin-left: 12px;
    }

    .outline-nav :global(.outline-item) {
        display: flex !important;
        justify-content: space-between !important;
        align-items: center !important;
        width: 100% !important;
        background: none !important;
        border: none !important;
        border-bottom: 1px dashed var(--outline-item-border) !important;
        padding: 10px 12px !important;
        padding-left: calc(12px + min(var(--depth), 8) * 12px) !important;
        font-family: var(--ui-font) !important;
        font-size: var(--font-size-lg) !important;
        font-weight: 700 !important;
        color: var(--text-color) !important;
        cursor: pointer !important;
        text-align: left !important;
        transition:
            background-color 0.1s cubic-bezier(0.4, 0, 0.2, 1),
            color 0.1s cubic-bezier(0.4, 0, 0.2, 1),
            box-shadow 0.1s cubic-bezier(0.4, 0, 0.2, 1) !important;
        box-sizing: border-box !important;
    }

    @media (hover: hover) {
        .outline-nav :global(.outline-item:hover:not(:disabled)) {
            background: var(--surface-hover-color) !important;
            color: var(--text-color) !important;
            font-weight: 800 !important;
        }
    }

    .outline-nav :global(.outline-item.active:not(:disabled)) {
        background: color-mix(
            in srgb,
            var(--accent-active-color) 24%,
            var(--surface-color)
        ) !important;
        color: var(--text-color) !important;
        box-shadow: inset 3px 0 0 var(--accent-active-color) !important;
        font-weight: 800 !important;
        border-bottom-style: solid !important;
    }

    .outline-nav :global(.outline-item:disabled) {
        opacity: 0.5 !important;
        cursor: not-allowed !important;
    }

    .heading-title {
        min-width: 0;
        flex: 1;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        margin-right: 8px;
    }

    .heading-page {
        background: var(--muted-bg-color);
        color: var(--muted-text-color);
        font-size: var(--font-size-2xs);
        font-weight: 900;
        min-width: 2rem;
        padding: 3px 6px;
        border: 0;
        border-radius: 0;
        flex-shrink: 0;
        background: var(--faded-color);
        color: var(--text-color);
        font-family: var(--ui-mono-font);
        font-variant-numeric: tabular-nums;
        text-align: center;
    }

    .outline-nav :global(.outline-item.selected:not(:disabled)) {
        background: color-mix(in srgb, var(--accent-color) 18%, var(--surface-color)) !important;
        box-shadow: inset 3px 0 0 var(--accent-color) !important;
        font-weight: 800 !important;
    }

    .outline-nav :global(.outline-item.active.selected:not(:disabled)) {
        background: color-mix(
            in srgb,
            var(--accent-active-color) 24%,
            var(--surface-color)
        ) !important;
        box-shadow: inset 3px 0 0 var(--accent-active-color) !important;
        font-weight: 800 !important;
    }

    @media (--tiny-mobile) {
        .outline-nav {
            padding: 4px 0 16px;
        }

        .outline-nav :global(.outline-item) {
            min-height: 48px !important;
            padding: 10px 14px !important;
            padding-left: calc(14px + min(var(--depth), 4) * 10px) !important;
            border-bottom-style: solid !important;
            border-bottom-color: var(--outline-item-border) !important;
            font-size: max(1rem, var(--font-size-lg)) !important;
            line-height: 1.25 !important;
        }

        .heading-title {
            overflow: visible;
            text-overflow: clip;
            white-space: normal;
            overflow-wrap: anywhere;
        }

        .heading-page {
            min-width: 2rem;
            padding: 3px 6px;
            border: 0;
            background: var(--faded-color);
            color: var(--text-color);
            font-family: ui-monospace, monospace;
            font-size: 0.75rem;
            font-variant-numeric: tabular-nums;
            text-align: center;
        }

        .outline-nav :global(.outline-item.active:not(:disabled)),
        .outline-nav :global(.outline-item.active.selected:not(:disabled)) {
            background: color-mix(
                in srgb,
                var(--accent-active-color) 24%,
                var(--surface-color)
            ) !important;
            box-shadow: inset 3px 0 0 var(--accent-active-color) !important;
        }
    }
</style>
