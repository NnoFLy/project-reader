<script lang="ts">
    import { viewport } from "$lib/shared/state/viewport.svelte"
    import * as m from "$lib/paraglide/messages"
    import AppUpdateButton from "$lib/shared/ui/AppUpdateButton.svelte"
    import Button from "$lib/shared/ui/Button.svelte"
    import MenuIcon from "$lib/shared/icons/MenuIcon.svelte"
    import SettingsIcon from "$lib/shared/icons/SettingsIcon.svelte"
    import BookmarkPlusIcon from "$lib/shared/icons/BookmarkPlusIcon.svelte"
    import BookmarkIcon from "$lib/shared/icons/BookmarkIcon.svelte"
    import CloseIcon from "$lib/shared/icons/CloseIcon.svelte"
    import MinusIcon from "$lib/shared/icons/MinusIcon.svelte"
    import PlusIcon from "$lib/shared/icons/PlusIcon.svelte"
    import { getContext } from "svelte"
    import {
        COMMANDS_CONTEXT_KEY,
        type CommandScope,
        getShortcutHint,
        commandsStore,
    } from "$lib/core/commands"

    let {
        name,
        isLoaded,
        isOutlineOpen = $bindable(),
        isSettingsOpen = $bindable(),
        isBookmarked = false,
    } = $props<{
        name: string
        isLoaded: boolean
        isOutlineOpen?: boolean
        isSettingsOpen?: boolean
        isBookmarked?: boolean
    }>()

    import { getViewerRuntimeContext } from "../viewerRuntime"
    const { executeCommand } = getViewerRuntimeContext()()

    const commandsNode = getContext<CommandScope>(COMMANDS_CONTEXT_KEY)
</script>

<header class="viewer-header">
    <div class="doc-info">
        {#if isLoaded}
            <Button
                class="left-sidebar-toggle"
                variant="action"
                size={viewport.isCompact ? "default" : "small"}
                square={viewport.isCompact}
                open={isOutlineOpen}
                onclick={() => void commandsStore.execute("viewer.sidebar.outline.toggle")}
                aria-label={m.outline()}
                tooltip={m.outline() +
                    getShortcutHint(commandsNode, "viewer.sidebar.outline.toggle")}
            >
                <MenuIcon />
                <span class="outline-text">{m.outline()}</span>
            </Button>
        {/if}
        <h1 class="file-name" title={name}>{name || m.unknown_book()}</h1>
    </div>

    <div class="header-actions">
        <AppUpdateButton />

        <Button
            variant="action"
            square={true}
            onclick={() => void executeCommand("settings.open")}
            aria-label={m.settings()}
            tooltip={m.settings()}
        >
            <SettingsIcon />
        </Button>

        {#if isLoaded}
            {#if isBookmarked}
                <Button
                    class="remove-bookmark-btn"
                    variant="action"
                    square={true}
                    onclick={() => void commandsStore.execute("viewer.bookmark.toggle-page")}
                    aria-label={m.remove_bookmark()}
                    tooltip={`${m.remove_bookmark()}${getShortcutHint(commandsNode, "viewer.bookmark.toggle-page")}`}
                >
                    <BookmarkIcon />
                </Button>
            {:else}
                <Button
                    variant="action"
                    square={true}
                    onclick={() => void commandsStore.execute("viewer.bookmark.toggle-page")}
                    aria-label={m.add_bookmark()}
                    tooltip={`${m.add_bookmark()}${getShortcutHint(commandsNode, "viewer.bookmark.toggle-page")}`}
                >
                    <BookmarkPlusIcon />
                </Button>
            {/if}
            {#if viewport.isPhoneLandscape}
                <div class="landscape-zoom-controls">
                    <Button
                        variant="action"
                        square={true}
                        onclick={() => void commandsStore.execute("settings.zoom.out")}
                        aria-label={m.zoom_out()}
                        tooltip={m.zoom_out() + getShortcutHint(commandsNode, "settings.zoom.out")}
                    >
                        <MinusIcon />
                    </Button>
                    <Button
                        variant="action"
                        square={true}
                        onclick={() => void commandsStore.execute("settings.zoom.in")}
                        aria-label={m.zoom_in()}
                        tooltip={m.zoom_in() + getShortcutHint(commandsNode, "settings.zoom.in")}
                    >
                        <PlusIcon />
                    </Button>
                </div>
            {/if}
            <Button
                variant="action"
                size={viewport.isCompact ? "default" : "small"}
                square={viewport.isCompact}
                open={isSettingsOpen}
                onclick={() => void commandsStore.execute("viewer.sidebar.settings.toggle")}
                aria-label={m.reading_controls()}
                tooltip={m.reading_controls() +
                    getShortcutHint(commandsNode, "viewer.sidebar.settings.toggle")}
            >
                <SettingsIcon />
                <span class="settings-text">{m.reading_controls()}</span>
            </Button>
        {/if}

        <Button
            variant="close"
            square={true}
            onclick={() => void commandsStore.execute("viewer.close")}
            aria-label={m.close_document()}
            tooltip={m.close_document() + getShortcutHint(commandsNode, "viewer.close")}
        >
            <CloseIcon />
        </Button>
    </div>
</header>

<style>
    :global(
        .viewer-header
            .remove-bookmark-btn:hover:not(:disabled):not(:active):not(.active):not(.open)
    ) {
        background: var(--danger-active-color) !important;
        color: var(--danger-text-color) !important;
    }

    :global(.viewer-header .left-sidebar-toggle.open:not(:active)) {
        box-shadow: var(--shadow-inline);
    }

    .viewer-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 12px;
        background: var(--viewer-chrome-color);
        border-block-end: var(--border-inline) solid var(--border-color);
        min-block-size: calc(52px + env(safe-area-inset-top));
        max-block-size: calc(52px + env(safe-area-inset-top));
        box-sizing: border-box;
        padding: calc(8px + env(safe-area-inset-top)) calc(16px + env(safe-area-inset-right)) 8px
            calc(16px + env(safe-area-inset-left));
        color: var(--text-color);
        font-family: var(--ui-font);
        position: relative;
        z-index: var(--z-dropdown);
    }

    .doc-info,
    .header-actions {
        display: flex;
        align-items: center;
    }

    .doc-info {
        gap: 10px;
        min-inline-size: 0;
        flex: 1;
    }

    .header-actions {
        gap: 8px;
        flex-shrink: 0;
    }

    .landscape-zoom-controls {
        display: flex;
        align-items: center;
        gap: 6px;
    }

    .file-name {
        min-inline-size: 0;
        margin: 0;
        font-size: var(--font-size-base);
        font-weight: 500;
        color: var(--text-color);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        font-family: var(--ui-font);
    }

    @media (--mobile) {
        .viewer-header {
            min-block-size: calc(46px + env(safe-area-inset-top));
            box-sizing: border-box;
            gap: 8px;
            padding: calc(4px + env(safe-area-inset-top)) calc(8px + env(safe-area-inset-right)) 4px
                calc(8px + env(safe-area-inset-left));
        }

        .doc-info {
            gap: 8px;
            overflow: hidden;
        }

        .header-actions {
            gap: 6px;
        }

        .file-name {
            font-size: max(0.875rem, var(--font-size-base));
            font-weight: 600;
        }

        .settings-text,
        .outline-text {
            display: none;
        }
    }

    @media (max-height: 500px) and (min-width: 801px) {
        .viewer-header {
            padding: 6px 16px;
            padding-top: calc(6px + env(safe-area-inset-top));
            padding-left: calc(16px + env(safe-area-inset-left));
            padding-right: calc(16px + env(safe-area-inset-right));
        }

        .file-name {
            font-size: var(--font-size-md);
        }
    }
</style>
