<script lang="ts">
    import Float from "$lib/shared/ui/modal/Float.svelte"
    import Button from "$lib/shared/ui/Button.svelte"
    import SearchIcon from "$lib/shared/icons/SearchIcon.svelte"
    import SearchNoResultsIcon from "$lib/shared/icons/SearchNoResultsIcon.svelte"
    import CloseIcon from "$lib/shared/icons/CloseIcon.svelte"
    import { useCommands } from "$lib/extensions/builtin/library/commands/commandsStore.svelte"
    import { createPromptCommands } from "../promptCommands"
    import type { PromptSnapshot } from "../prompt.types"
    import { promptStore } from "../stores/promptStore.svelte"
    import * as m from "$lib/paraglide/messages"
    import { onMount, tick } from "svelte"
    import { MEDIA_QUERIES } from "$lib/shared/state/breakpoints"
    import { fade, fly } from "svelte/transition"
    import { cubicOut } from "svelte/easing"
    import { motionPreferences } from "$lib/shared/state/motion.svelte"
    import PromptItem from "./PromptItem.svelte"

    let results: HTMLDivElement | undefined
    let snapshot = $derived(
        promptStore.snapshot as (PromptSnapshot & { errorLabel?: string }) | null,
    )

    function focusInput(node: HTMLInputElement) {
        queueMicrotask(() => {
            node.focus()
            node.select()
        })
    }

    function captureResults(node: HTMLDivElement) {
        results = node
    }

    async function scrollToSelection() {
        await tick()
        const selected = results?.querySelector<HTMLElement>("[aria-selected='true']")
        selected?.scrollIntoView({ block: "nearest" })
    }

    const promptCommands = createPromptCommands({
        close: () => promptStore.close(),
        next: () => {
            promptStore.moveSelection(1)
            void scrollToSelection()
        },
        previous: () => {
            promptStore.moveSelection(-1)
            void scrollToSelection()
        },
        select: () => promptStore.selectCurrent(),
        navigateBack: () => promptStore.navigateBack(),
        canNavigateBack: () => promptStore.canNavigateBack,
        historyBack: () => promptStore.historyBack(),
        historyForward: () => promptStore.historyForward(),
    })
    const promptCommandScope = useCommands(Object.values(promptCommands), undefined, {
        keyboardBoundary: true,
    })

    function handleKeydown(event: KeyboardEvent) {
        event.stopPropagation()
        promptCommandScope.handleKeydown(event)
    }

    onMount(() => {
        const phoneQuery = window.matchMedia(MEDIA_QUERIES.PHONE)
        let isLocked = false
        let scrollX = 0
        let scrollY = 0
        let previousBodyStyles: Partial<CSSStyleDeclaration> = {}
        let previousRootStyles: Partial<CSSStyleDeclaration> = {}

        function unlockPageScroll() {
            if (!isLocked) return

            Object.assign(document.body.style, previousBodyStyles)
            Object.assign(document.documentElement.style, previousRootStyles)
            window.scrollTo(scrollX, scrollY)
            isLocked = false
        }

        function updatePageScrollLock() {
            if (!phoneQuery.matches) {
                unlockPageScroll()
                return
            }
            if (isLocked) return

            scrollX = window.scrollX
            scrollY = window.scrollY
            previousBodyStyles = {
                position: document.body.style.position,
                top: document.body.style.top,
                left: document.body.style.left,
                right: document.body.style.right,
                width: document.body.style.width,
                overflow: document.body.style.overflow,
            }
            previousRootStyles = {
                overflow: document.documentElement.style.overflow,
                overscrollBehavior: document.documentElement.style.overscrollBehavior,
            }

            Object.assign(document.body.style, {
                position: "fixed",
                top: `${-scrollY}px`,
                left: `${-scrollX}px`,
                right: "0",
                width: "100%",
                overflow: "hidden",
            })
            Object.assign(document.documentElement.style, {
                overflow: "hidden",
                overscrollBehavior: "none",
            })
            isLocked = true
        }

        updatePageScrollLock()
        phoneQuery.addEventListener("change", updatePageScrollLock)

        return () => {
            phoneQuery.removeEventListener("change", updatePageScrollLock)
            unlockPageScroll()
        }
    })
</script>

{#if snapshot}
    {#key snapshot.request}
        <Float
            placement="top"
            backdrop="blur"
            wrapperClass="prompt-wrapper"
            onBackdropPointerDown={() => promptStore.close()}
            role="dialog"
            ariaModal={true}
            ariaLabel={snapshot.request.placeholder ?? m.prompt_search_aria()}
            class="prompt-float"
        >
            <div class="prompt-container" role="presentation" onkeydown={handleKeydown}>
                <form
                    class={["input-wrapper", snapshot.isLoading && "loading"]}
                    onsubmit={(event) => {
                        event.preventDefault()
                        void promptStore.selectCurrent()
                    }}
                >
                    <SearchIcon class="search-icon" />
                    <input
                        {@attach focusInput}
                        class="prompt-input"
                        type="search"
                        value={snapshot.query}
                        placeholder={snapshot.request.placeholder ?? m.prompt_placeholder()}
                        aria-label={m.prompt_search_aria()}
                        role="combobox"
                        aria-autocomplete="list"
                        aria-controls="prompt-results-list"
                        aria-expanded={snapshot.items.length > 0}
                        aria-activedescendant={snapshot.selectedIndex >= 0
                            ? `prompt-result-${snapshot.selectedIndex}`
                            : undefined}
                        oninput={(event) => promptStore.setQuery(event.currentTarget.value)}
                    />
                    <Button
                        type="button"
                        variant="close"
                        square
                        class="prompt-close-btn"
                        onclick={() => promptStore.close()}
                        aria-label={m.prompt_close_aria()}><CloseIcon /></Button
                    >
                </form>

                <div
                    {@attach captureResults}
                    id="prompt-results-list"
                    class="results-list"
                    role="listbox"
                    aria-label={m.prompt_search_aria()}
                >
                    {#if snapshot.items.length > 0}
                        {#each snapshot.items as item, index (item.id)}
                            <PromptItem
                                id={`prompt-result-${index}`}
                                {item}
                                isSelected={snapshot.selectedIndex === index}
                                animationDelay={motionPreferences.enabled
                                    ? Math.min(index, 6) * 18
                                    : 0}
                                onclick={() => {
                                    const offset = index - snapshot.selectedIndex
                                    if (offset) promptStore.moveSelection(offset)
                                    void promptStore.selectCurrent()
                                }}
                            />
                        {/each}
                    {:else}
                        <div
                            class="empty-state"
                            in:fly={{
                                y: 8,
                                duration: motionPreferences.enabled ? 180 : 0,
                                easing: cubicOut,
                            }}
                            out:fade={{ duration: motionPreferences.enabled ? 80 : 0 }}
                        >
                            {#if snapshot.isLoading}
                                <span class="loading-mark" aria-hidden="true"></span>
                                <p>{snapshot.request.loadingLabel ?? m.prompt_loading()}</p>
                            {:else if snapshot.errorLabel}
                                <SearchNoResultsIcon />
                                <p>{snapshot.errorLabel}</p>
                            {:else}
                                <SearchNoResultsIcon />
                                <p>
                                    {snapshot.request.emptyLabel ??
                                        m.prompt_no_results({ value: snapshot.query })}
                                </p>
                            {/if}
                        </div>
                    {/if}
                </div>

                <footer
                    in:fly={{
                        y: 6,
                        duration: motionPreferences.enabled ? 180 : 0,
                        delay: motionPreferences.enabled ? 70 : 0,
                        easing: cubicOut,
                    }}
                >
                    <span>{snapshot.items.length} {m.prompt_suggestions().toLocaleLowerCase()}</span
                    >
                    <span class="footer-help">
                        <span class="key-group">
                            {#each ["↓", "C-j", "C-n"] as key (key)}
                                <kbd>{key}</kbd>
                            {/each}
                            <span> / </span>
                            {#each ["↑", "C-k", "C-p"] as key (key)}
                                <kbd>{key}</kbd>
                            {/each}
                            {m.prompt_help_navigate()}
                        </span>
                        <span class="key-group"
                            ><kbd>A-n</kbd> <kbd>A-p</kbd> {m.prompt_help_history()}</span
                        >
                        <span class="key-group"><kbd>↵</kbd> {m.prompt_help_select()}</span>
                        <span class="key-group"><kbd>esc</kbd> {m.prompt_help_close()}</span>
                    </span>
                </footer>
            </div>
        </Float>
    {/key}
{/if}

<style>
    :global(.prompt-wrapper) {
        display: flex;
        flex-direction: column;
        align-items: center;
        padding: 40px 20px;
    }

    :global(.prompt-float) {
        width: min(44rem, calc(var(--float-viewport-width) - 2.5rem));
        max-width: 100%;
        max-height: 100%;
        margin-top: 80px;
        margin-bottom: auto;
        border: var(--border-elevated) solid var(--border-color);
        box-shadow: var(--shadow-elevated);
    }

    .prompt-container {
        display: flex;
        width: 100%;
        flex-direction: column;
        overflow: hidden;
        background: var(--surface-color);
        color: var(--text-color);
        font-family: var(--ui-font);
    }

    .input-wrapper {
        position: relative;
        display: flex;
        align-items: center;
        padding: 1rem;
        border-bottom: var(--border-inline) solid var(--border-color);
    }

    .input-wrapper::after {
        position: absolute;
        right: 0;
        bottom: -2px;
        left: 0;
        height: 2px;
        background: linear-gradient(90deg, #0984e3, #00b894, #e84393);
        content: "";
        opacity: 0;
    }

    .input-wrapper.loading::after {
        opacity: 1;
        animation: loading 1.2s ease-in-out infinite alternate;
    }

    @keyframes loading {
        to {
            filter: hue-rotate(80deg);
        }
    }

    :global(.search-icon) {
        width: 1.25rem;
        height: 1.25rem;
        margin-right: 0.75rem;
        opacity: 0.6;
    }

    .prompt-input {
        min-width: 0;
        flex: 1;
        padding: 0;
        border: 0;
        outline: 0;
        background: transparent;
        color: var(--text-color);
        font: inherit;
        font-size: var(--font-size-2xl);
    }

    .results-list {
        display: flex;
        max-height: 380px;
        flex-direction: column;
        gap: 0.25rem;
        overflow-y: auto;
        scrollbar-gutter: stable;
    }

    .empty-state {
        display: grid;
        min-height: 10rem;
        place-items: center;
        align-content: center;
        color: var(--text-color);
        opacity: 0.65;
    }

    :global(.empty-state svg) {
        width: 3rem;
        height: 3rem;
    }

    .loading-mark {
        width: 2rem;
        height: 2rem;
        border: 3px solid var(--border-color);
        border-top-color: transparent;
        border-radius: 50%;
        animation: spin 0.8s linear infinite;
    }

    @keyframes spin {
        to {
            transform: rotate(1turn);
        }
    }

    footer {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 0.65rem 1rem;
        border-top: var(--border-inline) solid var(--border-color);
        background: var(--surface-hover-color);
        color: var(--text-color);
        font-size: var(--font-size-sm);
        opacity: 0.8;
    }

    .footer-help,
    .key-group {
        display: flex;
        align-items: center;
        gap: 0.25rem;
    }

    .footer-help {
        flex-wrap: wrap;
        justify-content: flex-end;
        gap: 0.35rem 0.65rem;
    }

    footer kbd {
        padding: 0.1rem 0.25rem;
        border: 1px solid var(--border-color);
        border-radius: var(--radius-sm);
        font-family: ui-monospace, monospace;
    }

    @media (--prompt) {
        :global(.prompt-wrapper) {
            padding: 0;
        }

        :global(.prompt-float) {
            width: 100%;
            height: 100%;
            max-height: var(--float-viewport-height);
            margin: 0;
            border: 0;
            box-shadow: none;
        }

        .prompt-container {
            height: 100%;
            min-height: 0;
        }

        .input-wrapper {
            order: 1;
            flex: 0 0 auto;
            min-height: calc(
                56px + var(--float-safe-area-inset-bottom, env(safe-area-inset-bottom))
            );
            box-sizing: border-box;
            gap: 10px;
            padding: 6px calc(8px + env(safe-area-inset-right))
                calc(6px + var(--float-safe-area-inset-bottom, env(safe-area-inset-bottom)))
                calc(14px + env(safe-area-inset-left));
            border-bottom: 1px solid var(--border-color);
            background: var(--surface-color);
        }

        .input-wrapper::after {
            top: auto;
            bottom: -1px;
            height: 1px;
        }

        :global(.search-icon) {
            width: 20px;
            height: 20px;
            margin: 0;
            flex: 0 0 auto;
        }

        .prompt-input {
            font-size: max(1rem, var(--font-size-2xl));
        }

        .results-list {
            min-height: 0;
            max-height: none;
            flex: 1;
            flex-direction: column-reverse;
            padding: 24px calc(8px + env(safe-area-inset-right)) 12px
                calc(8px + env(safe-area-inset-left));
            scroll-padding-top: 24px;
            scrollbar-gutter: auto;
        }

        .results-list::after {
            content: "";
            flex: 0 0 var(--float-safe-area-inset-top, env(safe-area-inset-top));
        }

        .empty-state {
            min-height: 100%;
            padding: 24px;
            box-sizing: border-box;
            font-family: var(--ui-font);
            font-size: 1rem;
            text-align: center;
            opacity: 0.72;
        }

        .empty-state :global(svg) {
            display: none;
        }

        footer {
            display: none;
        }
    }

    @media (prefers-reduced-motion: reduce) {
        .input-wrapper.loading::after,
        .loading-mark {
            animation: none;
        }
    }
</style>
