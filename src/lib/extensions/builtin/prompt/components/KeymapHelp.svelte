<script lang="ts">
    import { commandsStore, KeyboardHandler } from "$lib/modules/commands"
    import { useModalCommands } from "$lib/modules/commands"
    import * as m from "$lib/paraglide/messages"
    import Modal from "$lib/shared/ui/modal/Modal.svelte"
    import Input from "$lib/shared/ui/Input.svelte"
    import { buildKeymapHelpItems, filterKeymapHelpItems } from "../keymapHelp"

    interface Props {
        animations?: boolean
        onClose: () => void
    }

    let { animations = true, onClose }: Props = $props()

    const activeNodeBeforeOpen = commandsStore.activeScope
    useModalCommands([], activeNodeBeforeOpen)

    let contentElement = $state<HTMLElement | null>(null)
    let searchQuery = $state("")
    let searchInputRef = $state<HTMLInputElement | null>(null)

    const keymaps = activeNodeBeforeOpen
        ? buildKeymapHelpItems(activeNodeBeforeOpen.listActive(), KeyboardHandler.normalize)
        : []

    let filteredKeymaps = $derived(filterKeymapHelpItems(keymaps, searchQuery))

    function handleSearchKeydown(event: KeyboardEvent) {
        if (KeyboardHandler.matches(event, ["arrowdown", "ctrl+n"])) {
            event.preventDefault()
            contentElement?.scrollBy({
                top: 80,
                behavior: !event.repeat && animations ? "smooth" : "auto",
            })
        } else if (KeyboardHandler.matches(event, ["arrowup", "ctrl+p"])) {
            event.preventDefault()
            contentElement?.scrollBy({
                top: -80,
                behavior: !event.repeat && animations ? "smooth" : "auto",
            })
        }
    }

    function handleKeydown(event: KeyboardEvent) {
        const target = event.target as HTMLElement | null
        const isInput =
            target?.tagName === "INPUT" ||
            target?.tagName === "TEXTAREA" ||
            target?.isContentEditable
        const closeKeys = ["ctrl+c", "ctrl+[", ...(isInput ? [] : ["q", "?"])]
        if (KeyboardHandler.matches(event, closeKeys)) {
            event.preventDefault()
            event.stopPropagation()
            onClose()
            return
        }
        if (!isInput && KeyboardHandler.matches(event, "/")) {
            event.preventDefault()
            event.stopPropagation()
            searchInputRef?.focus()
            searchInputRef?.select()
            return
        }

        const scroll = (top: number) => {
            event.preventDefault()
            event.stopPropagation()
            contentElement?.scrollBy({
                top,
                behavior: !event.repeat && animations ? "smooth" : "auto",
            })
        }
        if (KeyboardHandler.matches(event, ["arrowdown", ...(isInput ? [] : ["j"])])) {
            scroll(80)
        } else if (KeyboardHandler.matches(event, ["arrowup", ...(isInput ? [] : ["k"])])) {
            scroll(-80)
        } else if (!isInput && KeyboardHandler.matches(event, ["pagedown", "d"])) {
            scroll(200)
        } else if (!isInput && KeyboardHandler.matches(event, ["pageup", "u"])) {
            scroll(-200)
        }
    }

    function captureContent(node: HTMLElement) {
        contentElement = node
        return () => {
            if (contentElement === node) contentElement = null
        }
    }

    function formatKeys(keyStr: string): string[] {
        return KeyboardHandler.getFormattedParts(keyStr)
    }

    function getShortcutsArray(keys: string | string[]): string[] {
        return Array.isArray(keys) ? keys : [keys]
    }
</script>

<svelte:window onkeydowncapture={handleKeydown} />

<Modal
    variant="default"
    type="float"
    size="small"
    placement="center"
    onClose={() => onClose()}
    title={m.keymap_modal_title()}
    closeLabel={m.close()}
    initialFocus={() => searchInputRef}
    mobileFooter="fixed"
    draggable
>
    {#if keymaps.length > 0}
        <div class="modal-search">
            <Input
                unstyled
                bind:ref={searchInputRef}
                type="text"
                bind:value={searchQuery}
                placeholder="{m.keymap_search_shortcuts()} (/)"
                class="search-input"
                onkeydown={handleSearchKeydown}
            />
            {#if searchQuery}
                <button
                    class="clear-search-btn"
                    onclick={() => {
                        searchQuery = ""
                        searchInputRef?.focus()
                    }}
                    aria-label={m.clear_search_aria()}
                >
                    &times;
                </button>
            {/if}
        </div>
    {/if}

    <div class="modal-content" {@attach captureContent}>
        {#if filteredKeymaps.length === 0}
            <div class="empty-state">
                {#if searchQuery}
                    {m.keymap_no_matching_shortcuts()}
                {:else}
                    {m.keymap_no_shortcuts()}
                {/if}
            </div>
        {:else}
            <div class="shortcuts-grid">
                {#each filteredKeymaps as keymap (`${keymap.description}:${getShortcutsArray(keymap.keys).join(",")}`)}
                    <div class="shortcut-row">
                        <div class="key-combo">
                            {#each getShortcutsArray(keymap.keys) as shortcut, idx (shortcut)}
                                {#if idx > 0}
                                    <span class="shortcut-separator">/</span>
                                {/if}
                                {#each formatKeys(shortcut) as key, keyIndex (`${key}:${keyIndex}`)}
                                    <kbd class="key-badge">{key}</kbd>
                                {/each}
                            {/each}
                        </div>
                        <span class="shortcut-desc">
                            {keymap.description}
                            {#if keymap.englishDescription && keymap.englishDescription !== keymap.description}
                                ({keymap.englishDescription})
                            {/if}
                        </span>
                    </div>
                {/each}
            </div>
        {/if}
    </div>

    {#snippet footer()}
        <span class="footer-hint">{m.keymap_modal_close_hint()}</span>
    {/snippet}
</Modal>

<style>
    .modal-content {
        min-width: 0;
        min-height: 0;
        padding: 24px max(24px, var(--float-safe-area-inset-right, 0px)) 24px
            max(24px, var(--float-safe-area-inset-left, 0px));
        overflow-x: hidden;
        overflow-y: auto;
        flex: 1;
    }

    .shortcuts-grid {
        display: grid;
        grid-template-columns: 1fr;
        gap: 16px;
    }

    .shortcut-row {
        min-width: 0;
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 8px 12px;
        border-bottom: 1px dashed var(--border-color);
        transition: background 0.15s ease;
        gap: 16px;
    }

    @media (hover: hover) {
        .shortcut-row:hover {
            background: var(--surface-hover-color);
        }
    }

    .key-combo {
        min-width: 0;
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 4px;
        flex-shrink: 0;
    }

    .key-badge {
        font-family: Menlo, Monaco, Consolas, "Courier New", monospace;
        font-size: var(--font-size-base);
        font-weight: 700;
        background: var(--surface-color);
        color: var(--text-color);
        border: 2px solid var(--border-color);
        box-shadow: 2px 2px 0 var(--shadow-color);
        border-radius: var(--radius-md);
        padding: 4px 8px;
        min-width: 20px;
        text-align: center;
        text-transform: uppercase;
        display: inline-block;
    }

    .shortcut-separator {
        opacity: 0.5;
        font-weight: 500;
        margin: 0 2px;
        color: var(--text-color);
        font-size: var(--font-size-base);
    }

    .shortcut-desc {
        min-width: 0;
        overflow-wrap: anywhere;
        font-size: var(--font-size-xl);
        color: var(--text-color);
        text-align: right;
        font-weight: 500;
    }

    .footer-hint {
        font-size: var(--font-size-sm);
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.5px;
        opacity: 0.7;
    }

    .modal-search {
        position: relative;
        padding: 12px max(24px, var(--float-safe-area-inset-right, 0px)) 12px
            max(24px, var(--float-safe-area-inset-left, 0px));
        background: var(--bg-color);
        border-bottom: 2px solid var(--border-color);
        display: flex;
        align-items: center;
        flex-shrink: 0;
        box-sizing: border-box;
    }

    .modal-search :global(.search-input) {
        width: 100%;
        padding: 8px 36px 8px 12px;
        font-family: inherit;
        font-weight: 700;
        background: var(--surface-color);
        color: var(--text-color);
        border: 2px solid var(--border-color);
        box-shadow: 2px 2px 0 var(--shadow-color);
        outline: none;
        transition:
            background-color 0.15s cubic-bezier(0.4, 0, 0.2, 1),
            border-color 0.15s cubic-bezier(0.4, 0, 0.2, 1),
            color 0.15s cubic-bezier(0.4, 0, 0.2, 1),
            transform 0.15s cubic-bezier(0.4, 0, 0.2, 1);
        box-sizing: border-box;
        border-radius: var(--radius-md);
    }

    @media (max-width: 640px) {
        .modal-search :global(.search-input) {
            font-size: var(--font-size-xl);
        }
    }

    .modal-search :global(.search-input:focus-visible) {
        transform: translate(-1px, -1px);
        box-shadow: 3px 3px 0 var(--shadow-color);
        border-color: var(--border-color);
    }

    .clear-search-btn {
        position: absolute;
        right: calc(max(24px, var(--float-safe-area-inset-right, 0px)) + 8px);
        background: none;
        border: none;
        font-size: var(--font-size-3xl);
        font-weight: 800;
        cursor: pointer;
        color: var(--text-color);
        padding: 4px;
        display: flex;
        align-items: center;
        justify-content: center;
        opacity: 0.7;
        transition: opacity 0.1s ease;
    }

    @media (hover: hover) {
        .clear-search-btn:hover {
            opacity: 1;
        }
    }

    .empty-state {
        text-align: center;
        padding: 32px 0;
        opacity: 0.6;
        font-style: italic;
    }
</style>
