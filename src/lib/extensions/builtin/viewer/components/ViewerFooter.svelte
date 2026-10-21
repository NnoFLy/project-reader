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
    } from "$lib/core/commands"

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
    <div class="footer-scrub-bar">
        <Input
            unstyled
            type="range"
            min="1"
            max={totalPages}
            value={currentPage}
            oninput={(e) => {
                const page = parseInt((e.target as HTMLInputElement).value, 10)
                if (page >= 1 && page <= totalPages) {
                    void commandsStore.execute("viewer.page.go-to", {
                        page,
                        isJump: false,
                    })
                }
            }}
            class="footer-scrubber"
            disabled={isPageLoading}
            aria-label={m.scrub_slider_aria()}
        />
        <div class="footer-progress" style="width: {(currentPage / totalPages) * 100}%"></div>
    </div>

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
        gap: 10px;
        background: var(--viewer-chrome-color);
        border-block-start: var(--border-inline) solid var(--border-color);
        font-family: var(--ui-font);
        min-block-size: calc(52px + env(safe-area-inset-bottom));
        max-block-size: calc(52px + env(safe-area-inset-bottom));
        box-sizing: border-box;
        padding: 6px calc(16px + env(safe-area-inset-right)) calc(6px + env(safe-area-inset-bottom))
            calc(16px + env(safe-area-inset-left));
    }

    .viewer-footer :global(.action-btn) {
        min-inline-size: 0;
        flex: 0 1 auto;
        padding-inline: 16px;
        font-weight: 500;
    }

    .pagination-indicator {
        display: flex;
        align-items: center;
        gap: 12px;
        font-weight: 600;
        font-size: var(--font-size-base);
        color: var(--text-color);
        font-family: var(--ui-font);
        font-variant-numeric: tabular-nums;
        flex-shrink: 0;
    }

    .pagination-indicator :global(.page-input) {
        inline-size: 65px;
        block-size: 38px;
        border: 1px solid var(--color-control-border);
        border-radius: var(--radius-sm);
        text-align: center;
        font-family: var(--ui-font);
        font-variant-numeric: tabular-nums;
        font-weight: 500;
        background: var(--surface-color);
        color: var(--text-color);
        outline: none;
        transition:
            border-color 0.1s ease,
            background-color 0.1s ease;
    }

    .pagination-indicator :global(.page-input:focus-visible) {
        outline: 2px solid var(--focus-color);
        outline-offset: 2px;
    }

    .pagination-indicator :global(.page-input:disabled) {
        background: var(--disabled-bg-color);
        cursor: not-allowed;
    }

    .btn-text {
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        min-inline-size: 0;
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
        }

        .viewer-footer :global(.action-btn) {
            inline-size: var(--control-height-regular);
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
            min-inline-size: 0;
            justify-content: center;
            font-size: max(0.875rem, var(--font-size-base));
            gap: 6px;
            font-variant-numeric: tabular-nums;
        }

        .pagination-indicator :global(.page-input) {
            inline-size: 3rem;
            block-size: 32px;
            border-width: 1px;
            border-radius: var(--radius-sm);
            box-shadow: none;
            font-size: 1rem;
        }

        .page-label {
            display: none;
        }
    }

    /* Full-width scrub bar at the top edge of the footer on every screen size. */
    .footer-scrub-bar {
        position: absolute;
        top: 0;
        left: 0;
        right: 0;
        height: 4px;
        background: var(--surface-color);
        z-index: var(--z-10);
    }

    .footer-scrub-bar :global(.footer-scrubber) {
        position: absolute;
        top: -4px;
        left: 0;
        width: 100%;
        height: 12px;
        margin: 0;
        opacity: 0;
        cursor: pointer;
        z-index: 12;
    }

    .footer-scrub-bar:has(:global(.footer-scrubber:focus-visible)) {
        outline: 2px solid var(--focus-color);
        outline-offset: 2px;
    }

    .footer-scrub-bar :global(.footer-scrubber:disabled) {
        cursor: not-allowed;
    }

    .footer-progress {
        height: 4px;
        background: var(--progress-color);
        transition: width 0.1s ease;
        z-index: 11;
        pointer-events: none;
    }
</style>
