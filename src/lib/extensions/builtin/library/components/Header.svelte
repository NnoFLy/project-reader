<script lang="ts">
    import { viewport } from "$lib/shared/state/viewport.svelte"
    import SunIcon from "$lib/shared/icons/SunIcon.svelte"
    import MoonIcon from "$lib/shared/icons/MoonIcon.svelte"
    import SystemIcon from "$lib/shared/icons/SystemIcon.svelte"
    import GlobeIcon from "$lib/shared/icons/GlobeIcon.svelte"
    import { getLocale } from "$lib/paraglide/runtime"
    import { settingsStore } from "../state/librarySettings"
    import * as m from "$lib/paraglide/messages"

    import { getLanguageName } from "../state/librarySettings"
    import AppUpdateButton from "$lib/shared/ui/AppUpdateButton.svelte"
    import TerminalIcon from "$lib/shared/icons/TerminalIcon.svelte"
    import { vfsStore } from "../state/libraryStore.svelte"
    import Button from "$lib/shared/ui/Button.svelte"
    import BookOpenIcon from "$lib/shared/icons/BookOpenIcon.svelte"
    import { getContext } from "svelte"
    import {
        COMMANDS_CONTEXT_KEY,
        type CommandScope,
        getShortcutHint,
        commandsStore,
    } from "../commands/commandsStore.svelte"

    const THEMES = [
        { value: "light", label: () => m.light(), Icon: SunIcon },
        { value: "dark", label: () => m.dark(), Icon: MoonIcon },
        { value: "system", label: () => m.system(), Icon: SystemIcon },
    ] as const

    const currentThemeInfo = $derived(
        THEMES.find((t) => t.value === settingsStore.theme) || THEMES[2],
    )

    const currentBook = $derived(
        vfsStore.activeFileId ? vfsStore.nodes[vfsStore.activeFileId] : undefined,
    )
    const commandsNode = getContext<CommandScope>(COMMANDS_CONTEXT_KEY)
</script>

<header>
    <div class="title-wrapper">
        <h1 class="title" data-text={m.library()}>
            {m.library()}
        </h1>
    </div>
    <div class="actions-wrapper" role="toolbar" aria-label={m.action_controls()}>
        <div class="header-btn-wrapper">
            <AppUpdateButton />

            {#if !viewport.isCompact}
                <Button
                    variant="action"
                    class="search-prompt-button"
                    square
                    onclick={() => void commandsNode.execute("prompt.open")}
                    aria-label={m.keymap_prompt()}
                    tooltip={`${m.keymap_prompt()}${getShortcutHint(commandsNode, "prompt.open")}`}
                >
                    <TerminalIcon class="search-icon" />
                </Button>
            {/if}

            {#if currentBook}
                <Button
                    variant="action"
                    class="continue-btn"
                    onclick={() => void commandsStore.execute("library.continue-reading")}
                    aria-label={m.continue_reading()}
                    tooltip={`${m.continue_reading()}${getShortcutHint(commandsNode, "library.continue-reading")}`}
                >
                    <BookOpenIcon class="switcher-icon" />
                </Button>
            {/if}

            <div class="switchers-group">
                <Button
                    variant="action"
                    class="settings-trigger"
                    onclick={() => void commandsStore.execute("settings.theme")}
                    aria-label={m.select_theme()}
                    tooltip={m.select_theme()}
                >
                    <currentThemeInfo.Icon class="switcher-icon" />
                    <span class="current-label">{currentThemeInfo.label()}</span>
                </Button>

                <Button
                    variant="action"
                    class="settings-trigger"
                    onclick={() => void commandsStore.execute("settings.language")}
                    aria-label={m.language_switcher()}
                    tooltip={m.language_switcher()}
                >
                    <GlobeIcon class="switcher-icon" />
                    <span class="current-label">{getLanguageName(getLocale())}</span>
                </Button>
            </div>
        </div>
    </div>
</header>

<style>
    header {
        --header-control-height: var(--control-height-compact);
        display: flex;
        justify-content: space-between;
        align-items: flex-end;
        border-bottom: 3px solid var(--border-color);
        padding-bottom: 24px;
        margin-bottom: 20px;
        gap: 20px;
        flex-wrap: wrap;
    }

    .title-wrapper {
        position: relative;
    }

    .title {
        font-size: clamp(var(--font-size-6xl), 6vw, var(--font-size-7xl));
        margin: 0;
        text-transform: uppercase;
        font-weight: 900;
        letter-spacing: -2px;
        position: relative;
        display: inline-block;
        color: var(--text-color);
        line-height: 1;
    }

    .actions-wrapper {
        display: flex;
        align-items: center;
        gap: 24px;
    }

    .header-btn-wrapper {
        display: flex;
        align-items: center;
        gap: 12px;
        flex-wrap: wrap;
    }

    .switchers-group {
        display: flex;
        align-items: center;
        gap: 12px;
        margin-left: auto;
    }

    .header-btn-wrapper :global(.action-btn) {
        height: var(--header-control-height);
        min-height: var(--header-control-height);
        max-height: var(--header-control-height);
        box-sizing: border-box;
    }

    .header-btn-wrapper :global(.action-btn) {
        background: var(--surface-color);
        border: 2px solid var(--border-color);
        padding: 8px 16px;
        box-shadow: var(--shadow-inline);
        transition:
            background-color 0.15s cubic-bezier(0.4, 0, 0.2, 1),
            border-color 0.15s cubic-bezier(0.4, 0, 0.2, 1),
            color 0.15s cubic-bezier(0.4, 0, 0.2, 1),
            transform 0.15s cubic-bezier(0.4, 0, 0.2, 1);
    }

    @media (hover: hover) {
        .header-btn-wrapper :global(.action-btn:hover) {
            transform: translate(-2px, -2px);
            box-shadow: 4px 4px 0 var(--shadow-color);
            background: var(--surface-hover-color);
        }
    }

    .header-btn-wrapper :global(.action-btn:active) {
        transform: translate(2px, 2px);
        box-shadow: 0px 0px 0 var(--shadow-color);
    }

    .header-btn-wrapper :global(.search-prompt-button) {
        position: relative;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: var(--header-control-height);
        min-width: var(--header-control-height);
        padding: 0 !important;
        line-height: 0;
    }

    .header-btn-wrapper :global(.search-prompt-button .search-icon) {
        display: block;
        width: 16px;
        height: 16px;
        margin: 0;
        flex: 0 0 auto;
    }

    :global(.switcher-icon) {
        width: 16px;
        height: 16px;
        stroke-width: 2.5;
    }

    .current-label {
        letter-spacing: 0.5px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        min-width: 0;
    }

    @media (--tablet) {
        header {
            flex-direction: column;
            align-items: flex-start;
            padding-bottom: 20px;
            gap: 20px;
        }

        .actions-wrapper {
            width: 100%;
        }

        .header-btn-wrapper {
            width: 100%;
            flex-wrap: wrap;
            gap: 16px;
        }
    }

    :global(.continue-btn) {
        padding: 6px 12px !important;
        font-size: var(--font-size-base) !important;
        display: inline-flex;
        align-items: center;
        justify-content: center;
    }

    @media (--phone) {
        header {
            --header-control-height: var(--control-height-regular);
            display: grid;
            grid-template-columns: minmax(0, 1fr);
            align-items: start;
            gap: 12px;
            padding-bottom: 14px;
        }

        .title-wrapper {
            min-width: 0;
            width: 100%;
        }

        .title {
            max-width: 100%;
            font-size: clamp(2rem, 11vw, 2.75rem);
            letter-spacing: -1px;
            overflow-wrap: anywhere;
        }

        .actions-wrapper,
        .header-btn-wrapper {
            width: 100%;
            min-width: 0;
        }

        .header-btn-wrapper {
            gap: 6px;
            flex-wrap: wrap;
        }

        .header-btn-wrapper :global(.app-update-button) {
            flex: 0 0 100%;
            width: 100%;
            max-width: 100%;
            justify-content: center;
        }

        .switchers-group {
            flex: 0 0 auto;
            gap: 6px;
        }

        :global(.continue-btn) {
            width: var(--header-control-height) !important;
            min-width: var(--header-control-height) !important;
            padding: 0 !important;
        }
    }
</style>
