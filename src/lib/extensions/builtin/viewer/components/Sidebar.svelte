<script lang="ts">
    import * as m from "$lib/paraglide/messages"
    import MenuIcon from "$lib/shared/icons/MenuIcon.svelte"
    import NoteIcon from "$lib/shared/icons/NoteIcon.svelte"
    import BookmarkIcon from "$lib/shared/icons/BookmarkIcon.svelte"
    import { settingsStore } from "$lib/core/settings"
    import { commandsStore, getShortcutHint, useCommands } from "$lib/core/commands"
    import { createViewerSidebarCloseCommand } from "../commands/viewerSidebarCloseCommand"
    import { untrack } from "svelte"
    import type { DocumentOutlineEntry } from "$lib/document-model"
    import { Sidebar as GlobalSidebar, SidebarHeader } from "$lib/shared/ui/sidebar"
    import Tabs from "$lib/shared/ui/Tabs.svelte"
    import TabItem from "$lib/shared/ui/TabItem.svelte"
    import OutlineSidebar from "./OutlineSidebar.svelte"
    import NotesSidebar from "./NotesSidebar.svelte"
    import BookmarksSidebar from "./BookmarksSidebar.svelte"
    import SettingsSidebar from "./SettingsSidebar.svelte"
    import { notesStore } from "../stores/notesStore.svelte"
    import { modalManager } from "$lib/shared/ui/modal/modalManager.svelte"
    import { Slider, type SliderDirection } from "$lib/shared/ui/slider"
    import {
        LEFT_SIDEBAR_TABS,
        getAdjacentSidebarTab,
        resolveSidebarTabMove,
        type LeftSidebarTabId,
    } from "./sidebarTabs"

    let {
        side = "left",
        activeTab = $bindable("outline"),
        onClose,
        onMouseLeave,
        presentation = "overlay",
        showBackdrop = presentation === "overlay",
        isOutlineLoading = false,
        outlineList = null,
        currentPage = $bindable(1),
        scrollPosition = $bindable(0),
        activeHeadings = new Set(),
    } = $props<{
        side?: "left" | "right"
        activeTab: "outline" | "notes" | "bookmarks" | "settings"
        onClose: () => void
        onMouseLeave?: (event: MouseEvent) => void
        presentation?: "docked" | "overlay"
        showBackdrop?: boolean
        isOutlineLoading?: boolean
        outlineList?: DocumentOutlineEntry[] | null
        currentPage?: number
        scrollPosition?: number
        activeHeadings?: Set<DocumentOutlineEntry>
    }>()

    const uid = $props.id()
    const initialSide = untrack(() => side)
    const isSettingsSidebar = initialSide === "right"
    const panelLabel = $derived(
        activeTab === "notes"
            ? m.notes_highlights()
            : activeTab === "bookmarks"
              ? m.bookmarks()
              : activeTab === "settings"
                ? m.settings()
                : m.outline(),
    )
    const shortcutScope = commandsStore.activeScope ?? commandsStore.root
    const outlineTab = LEFT_SIDEBAR_TABS[0]
    const notesTab = LEFT_SIDEBAR_TABS[1]
    const bookmarksTab = LEFT_SIDEBAR_TABS[2]

    function isEditableTarget(target: EventTarget | null) {
        return (
            target instanceof HTMLInputElement ||
            target instanceof HTMLTextAreaElement ||
            (target instanceof HTMLElement && target.isContentEditable)
        )
    }

    const sidebarCommand = createViewerSidebarCloseCommand({
        label: () => (isSettingsSidebar ? m.keymap_close_settings() : m.keymap_close_sidebar()),
        englishLabel: () =>
            isSettingsSidebar
                ? m.keymap_close_settings({}, { locale: "en" })
                : m.keymap_close_sidebar({}, { locale: "en" }),
        disabled: () =>
            (!isSettingsSidebar && modalManager.hasBlockingModal) ||
            !!notesStore.editingNote ||
            !!notesStore.activePopup,
        shouldHandleKey: (event: KeyboardEvent) => {
            if (!isEditableTarget(event.target)) return true

            const key = event.key.toLowerCase()
            return key !== "q"
        },
        close: () => onClose(),
    })
    const sidebarCommandsNode = useCommands(
        [sidebarCommand],
        isSettingsSidebar ? shortcutScope : undefined,
    )

    function closeSidebar() {
        void sidebarCommandsNode.execute("viewer.sidebar.close")
    }

    function getSwipeDestination(direction: SliderDirection) {
        if (side !== "left" || activeTab === "settings") return undefined
        return getAdjacentSidebarTab(activeTab, direction)
    }

    function resolveSwipeTab(direction: SliderDirection) {
        if (side !== "left" || activeTab === "settings") return undefined
        return resolveSidebarTabMove(
            activeTab,
            direction,
            () => activeTab,
            (commandId) => void shortcutScope.execute(commandId),
        )
    }
</script>

{#snippet header()}
    <SidebarHeader
        {side}
        onClose={closeSidebar}
        closeLabel={m.close()}
        closeTooltip={m.close() + getShortcutHint(sidebarCommandsNode, "viewer.sidebar.close")}
    >
        {#if side === "left"}
            <Tabs
                class="sidebar-tabs-list"
                activeValue={activeTab}
                ariaLabel={m.viewer_sidebar_tabs()}
            >
                <TabItem
                    id={`${uid}-outline-tab`}
                    controls={`${uid}-outline-panel`}
                    ariaLabel={m.outline()}
                    active={activeTab === outlineTab.id}
                    onclick={() => void shortcutScope.execute(outlineTab.commandId)}
                    Icon={MenuIcon}
                    tooltip={m.outline() +
                        getShortcutHint(shortcutScope, "viewer.sidebar.outline.toggle")}
                />
                <TabItem
                    id={`${uid}-notes-tab`}
                    controls={`${uid}-notes-panel`}
                    ariaLabel={m.notes_highlights()}
                    active={activeTab === notesTab.id}
                    onclick={() => void shortcutScope.execute(notesTab.commandId)}
                    Icon={NoteIcon}
                    tooltip={m.notes_highlights() +
                        getShortcutHint(shortcutScope, "viewer.sidebar.notes.toggle")}
                />
                <TabItem
                    id={`${uid}-bookmarks-tab`}
                    controls={`${uid}-bookmarks-panel`}
                    ariaLabel={m.bookmarks()}
                    active={activeTab === bookmarksTab.id}
                    onclick={() => void shortcutScope.execute(bookmarksTab.commandId)}
                    Icon={BookmarkIcon}
                    tooltip={m.bookmarks() +
                        getShortcutHint(shortcutScope, "viewer.sidebar.bookmarks.toggle")}
                />
            </Tabs>
        {:else}
            <h3>{m.settings()}</h3>
        {/if}
    </SidebarHeader>
{/snippet}

{#snippet sidebarPanel(tab: LeftSidebarTabId, interactive: boolean)}
    <div
        class="sidebar-panel"
        id={`${uid}-${tab}-panel`}
        role="tabpanel"
        aria-labelledby={`${uid}-${tab}-tab`}
    >
        {#if tab === "outline"}
            <OutlineSidebar
                {isOutlineLoading}
                {outlineList}
                bind:currentPage
                bind:scrollPosition
                {activeHeadings}
                {onClose}
                {interactive}
            />
        {:else if tab === "notes"}
            <NotesSidebar {onClose} {interactive} />
        {:else}
            <BookmarksSidebar {onClose} {interactive} />
        {/if}
    </div>
{/snippet}

<GlobalSidebar
    {side}
    {presentation}
    {showBackdrop}
    onClose={closeSidebar}
    {onMouseLeave}
    duration={settingsStore.animations ? 150 : 0}
    backdropLabel={m.close()}
    ariaLabel={panelLabel}
    {header}
>
    {#if side === "left" && activeTab !== "settings"}
        {#key activeTab}
            <Slider
                enabled={!modalManager.hasBlockingModal &&
                    !notesStore.editingNote &&
                    !notesStore.activePopup}
                resolveMove={resolveSwipeTab}
                ariaLabel={panelLabel}
            >
                {#snippet previous()}
                    {@const destination = getSwipeDestination("previous")}
                    {#if destination}
                        {@render sidebarPanel(destination.id, false)}
                    {/if}
                {/snippet}

                {#snippet current()}
                    {@render sidebarPanel(activeTab, true)}
                {/snippet}

                {#snippet next()}
                    {@const destination = getSwipeDestination("next")}
                    {#if destination}
                        {@render sidebarPanel(destination.id, false)}
                    {/if}
                {/snippet}
            </Slider>
        {/key}
    {:else}
        <SettingsSidebar />
    {/if}
</GlobalSidebar>

<style>
    :global(.sidebar-tabs-list) {
        flex: 1;
        min-width: 0;
    }

    .sidebar-panel {
        display: flex;
        flex: 1;
        width: 100%;
        min-height: 0;
        flex-direction: column;
    }

    h3 {
        margin: 0;
        color: var(--text-color);
        font-size: var(--font-size-lg);
        font-weight: 500;
    }
</style>
