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
    } from "../commands/commandsStore.svelte"
    import { executeLibraryHostCommand } from "../state/libraryHostBridge"

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
        <span class="wordmark"><BookOpenIcon /> VFS</span>
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
                    onclick={() => void executeLibraryHostCommand("prompt.open")}
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
                    onclick={() => void commandsNode.execute("library.continue-reading")}
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
                    onclick={() => void executeLibraryHostCommand("settings.theme")}
                    aria-label={m.select_theme()}
                    tooltip={m.select_theme()}
                >
                    <currentThemeInfo.Icon class="switcher-icon" />
                    <span class="current-label">{currentThemeInfo.label()}</span>
                </Button>

                <Button
                    variant="action"
                    class="settings-trigger"
                    onclick={() => void executeLibraryHostCommand("settings.language")}
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
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: var(--space-4);
        min-block-size: 56px;
        padding-block-end: 22px;
        margin-block-end: 22px;
        border-block-end: 1px solid var(--color-rule);
    }
    .title-wrapper,
    .wordmark,
    .actions-wrapper,
    .header-btn-wrapper,
    .switchers-group {
        display: flex;
        align-items: center;
    }
    .title-wrapper {
        gap: var(--space-5);
        min-inline-size: 0;
    }
    .wordmark {
        flex-shrink: 0;
        gap: var(--space-2);
        font-weight: 600;
        font-size: var(--font-size-lg);
    }
    .wordmark :global(svg) {
        width: 22px;
        height: 22px;
    }
    .title {
        min-inline-size: 0;
        overflow-wrap: anywhere;
        margin: 0;
        font-size: var(--font-size-3xl);
        font-weight: 500;
        letter-spacing: -0.025em;
        line-height: 1.3;
    }
    .header-btn-wrapper,
    .switchers-group {
        gap: var(--space-1);
    }
    .current-label {
        white-space: nowrap;
    }
    @media (--mobile-width) {
        header {
            gap: var(--space-2);
            padding-block-end: var(--space-4);
            margin-block-end: var(--space-4);
        }
        .title-wrapper {
            gap: var(--space-3);
        }
        .title {
            font-size: var(--font-size-2xl);
        }
        .wordmark {
            font-size: var(--font-size-base);
        }
        .wordmark :global(svg) {
            display: none;
        }
        .current-label {
            display: none;
        }
        .header-btn-wrapper :global(.settings-trigger) {
            inline-size: var(--control-height-regular);
            padding: 0;
        }
        .header-btn-wrapper:has(:global(.app-update-button)) {
            flex-wrap: wrap;
            justify-content: flex-end;
        }
    }
</style>
