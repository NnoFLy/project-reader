<script lang="ts">
    import { viewport } from "$lib/shared/state/viewport.svelte"
    import * as m from "$lib/paraglide/messages"
    import Button from "$lib/shared/ui/Button.svelte"
    import Input from "$lib/shared/ui/Input.svelte"
    import { getContext } from "svelte"
    import {
        COMMANDS_CONTEXT_KEY,
        type CommandScope,
        getShortcutHint,
        commandsStore,
    } from "$lib/modules/commands"

    const commandsNode = getContext<CommandScope>(COMMANDS_CONTEXT_KEY)

    let { currentPage, totalPages, isPageLoading } = $props<{
        currentPage: number
        totalPages: number
        isPageLoading: boolean
    }>()

    function handlePageInput(event: Event) {
        const input = event.target as HTMLInputElement
        const value = parseInt(input.value, 10)
        if (!isNaN(value) && value >= 1 && value <= totalPages) {
            void commandsStore.execute("viewer.page.go-to", { page: value })
        } else {
            input.value = currentPage.toString()
        }
    }
</script>

<footer class="viewer-footer" aria-label={m.viewer_footer()}>
    {#if viewport.isCompact}
        <div class="mobile-scrub-bar">
            <Input
                unstyled
                type="range"
                min="1"
                max={totalPages}
                value={currentPage}
                oninput={(e) => {
                    const val = parseInt((e.target as HTMLInputElement).value, 10)
                    if (!isNaN(val) && val >= 1 && val <= totalPages) {
                        void commandsStore.execute("viewer.page.go-to", {
                            page: val,
                            isJump: false,
                        })
                    }
                }}
                class="mobile-scrubber"
                disabled={isPageLoading}
                aria-label={m.mobile_scrub_slider_aria()}
            />
            <div class="mobile-progress" style="width: {(currentPage / totalPages) * 100}%"></div>
        </div>
    {/if}

    <Button
        variant="action"
        size={viewport.isCompact ? "default" : "large"}
        onclick={() => void commandsStore.execute("viewer.page.previous")}
        square={viewport.isCompact}
        disabled={currentPage <= 1 || isPageLoading}
        aria-label={m.prev_page()}
        tooltip={m.prev_page() + getShortcutHint(commandsNode, "viewer.page.previous")}
    >
        <span class="btn-text">{m.prev_page()}</span>
        <span class="btn-arrow">←</span>
    </Button>

    <div class="pagination-indicator">
        <span class="page-label">{m.page()}</span>
        <Input
            unstyled
            type="number"
            inputmode="numeric"
            pattern="[0-9]*"
            aria-label={m.page_number_aria()}
            value={currentPage}
            min="1"
            max={totalPages}
            onchange={handlePageInput}
            class="page-input"
            disabled={isPageLoading}
        />
        {m.of_pages({ total: totalPages })}
    </div>

    {#if !viewport.isCompact}
        <div class="scrubber-container">
            <Input
                unstyled
                type="range"
                min="1"
                max={totalPages}
                value={currentPage}
                oninput={(e) => {
                    const val = parseInt((e.target as HTMLInputElement).value, 10)
                    if (!isNaN(val) && val >= 1 && val <= totalPages) {
                        void commandsStore.execute("viewer.page.go-to", {
                            page: val,
                            isJump: false,
                        })
                    }
                }}
                class="footer-scrubber"
                style={`--progress: ${(currentPage / totalPages) * 100}%`}
                disabled={isPageLoading}
                aria-label={m.scrub_slider_aria()}
            />
        </div>
    {/if}

    <Button
        variant="action"
        size={viewport.isCompact ? "default" : "large"}
        onclick={() => void commandsStore.execute("viewer.page.next")}
        square={viewport.isCompact}
        disabled={currentPage >= totalPages || isPageLoading}
        aria-label={m.next_page()}
        tooltip={m.next_page() + getShortcutHint(commandsNode, "viewer.page.next")}
    >
        <span class="btn-text">{m.next_page()}</span>
        <span class="btn-arrow">→</span>
    </Button>
</footer>

<style>
    .viewer-footer {
        position: relative;
        z-index: var(--z-10);
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 16px;
        background: var(--viewer-chrome-color);
        border-top: var(--border-inline) solid var(--border-color);
        font-family: var(--ui-font);
        min-height: calc(56px + env(safe-area-inset-bottom));
        max-height: calc(56px + env(safe-area-inset-bottom));
        box-sizing: border-box;
        padding: 6px calc(16px + env(safe-area-inset-right)) calc(6px + env(safe-area-inset-bottom))
            calc(16px + env(safe-area-inset-left));
    }

    .viewer-footer :global(.action-btn) {
        min-width: 0;
        flex: 0 1 auto;
        padding-inline: 16px;
        font-weight: 700;
    }

    .pagination-indicator {
        display: flex;
        align-items: center;
        gap: 12px;
        font-weight: 700;
        font-size: var(--font-size-xl);
        color: var(--text-color);
        font-family: var(--ui-font);
        font-variant-numeric: tabular-nums;
        flex-shrink: 0;
    }

    .pagination-indicator :global(.page-input) {
        width: 65px;
        height: 38px;
        border: var(--border-inline) solid var(--border-color);
        box-shadow: var(--shadow-inline);
        text-align: center;
        font-family: var(--ui-mono-font);
        font-weight: 700;
        background: var(--surface-color);
        color: var(--text-color);
        outline: none;
        transition:
            border-color 0.1s ease,
            background-color 0.1s ease;
    }

    .pagination-indicator :global(.page-input:focus-visible) {
        border-color: var(--accent-color);
    }

    .pagination-indicator :global(.page-input:disabled) {
        background: var(--disabled-bg-color);
        cursor: not-allowed;
    }

    .btn-text {
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        min-width: 0;
    }

    .btn-arrow {
        display: none;
    }

    @media (--mobile) {
        .viewer-footer {
            display: grid;
            grid-template-columns: 44px minmax(0, 1fr) 44px;
            box-sizing: border-box;
            gap: 12px;
            padding: 6px calc(10px + env(safe-area-inset-right))
                calc(6px + env(safe-area-inset-bottom)) calc(10px + env(safe-area-inset-left));
            border-top-width: var(--border-inline);
        }

        .viewer-footer :global(.action-btn) {
            width: var(--control-height-regular);
            flex: 0 0 var(--control-height-regular);
            padding: 0;
        }

        .btn-text {
            display: none;
        }

        .btn-arrow {
            display: inline-block;
            font-size: var(--font-size-2xl);
            font-weight: 900;
        }

        .pagination-indicator {
            min-width: 0;
            justify-content: center;
            font-size: max(0.875rem, var(--font-size-base));
            gap: 6px;
            font-variant-numeric: tabular-nums;
        }

        .pagination-indicator :global(.page-input) {
            width: 3rem;
            height: 32px;
            border-width: 1px;
            border-radius: 0;
            box-shadow: none;
            font-size: 1rem;
        }
    }

    @media (--mobile) {
        .page-label {
            display: none;
        }
    }

    /* Scrubber Styles */
    .scrubber-container {
        flex: 1;
        max-width: 320px;
        margin: 0 16px;
        display: flex;
        align-items: center;
    }

    .scrubber-container :global(.footer-scrubber) {
        width: 100%;
        height: 10px;
        appearance: none;
        -webkit-appearance: none;
        background: linear-gradient(
            to right,
            var(--color-marker) 0 var(--progress),
            var(--surface-color) var(--progress) 100%
        );
        border: var(--border-inline) solid var(--border-color);
        box-shadow: var(--shadow-inline);
        outline: none;
        box-sizing: border-box;
    }

    .scrubber-container :global(.footer-scrubber::-webkit-slider-thumb) {
        appearance: none;
        -webkit-appearance: none;
        width: 14px;
        height: 22px;
        background: var(--accent-active-color);
        border: 2px solid var(--border-color);
        box-shadow: 1px 1px 0 var(--shadow-color);
        cursor: pointer;
        transition: transform 0.1s ease;
    }

    .scrubber-container :global(.footer-scrubber::-webkit-slider-thumb:hover) {
        transform: scale(1.1);
    }

    .scrubber-container :global(.footer-scrubber::-moz-range-thumb) {
        width: 14px;
        height: 22px;
        background: var(--accent-active-color);
        border: 2px solid var(--border-color);
        box-shadow: 1px 1px 0 var(--shadow-color);
        cursor: pointer;
        border-radius: 0;
        transition: transform 0.1s ease;
    }

    .scrubber-container :global(.footer-scrubber::-moz-range-thumb:hover) {
        transform: scale(1.1);
    }

    /* Mobile Scrub Bar at the top edge of footer */
    .mobile-scrub-bar {
        position: absolute;
        top: -4px;
        left: 0;
        right: 0;
        height: 12px;
        z-index: var(--z-10);
        display: flex;
        align-items: center;
    }

    .mobile-scrub-bar :global(.mobile-scrubber) {
        position: absolute;
        inset: 0;
        width: 100%;
        height: 100%;
        margin: 0;
        opacity: 0;
        cursor: pointer;
        z-index: 12;
    }

    .mobile-progress {
        height: 4px;
        background: var(--accent-active-color);
        border-bottom: 2px solid var(--border-color);
        transition: width 0.1s ease;
        z-index: 11;
        pointer-events: none;
    }
</style>
