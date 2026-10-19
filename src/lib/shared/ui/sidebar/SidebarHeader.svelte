<script lang="ts">
    import type { Snippet } from "svelte"
    import CloseIcon from "$lib/shared/icons/CloseIcon.svelte"
    import Button from "../Button.svelte"

    let {
        side = "left",
        title,
        children,
        onClose,
        closeLabel = "Close",
        closeTooltip,
    } = $props<{
        side?: "left" | "right"
        title?: string
        children?: Snippet
        onClose?: () => void
        closeLabel?: string
        closeTooltip?: string
    }>()
</script>

<header class={["sidebar-header", side]}>
    <div class="sidebar-header-content">
        {#if children}
            {@render children()}
        {:else if title}
            <h2>{title}</h2>
        {/if}
    </div>
    {#if onClose}
        <Button
            variant="close"
            square
            onclick={onClose}
            aria-label={closeLabel}
            tooltip={closeTooltip}
            class="sidebar-close-btn"
        >
            <CloseIcon />
        </Button>
    {/if}
</header>

<style>
    .sidebar-header {
        position: relative;
        z-index: var(--z-10);
        display: flex;
        flex-shrink: 0;
        align-items: center;
        justify-content: space-between;
        box-sizing: border-box;
        height: 48px;
        gap: 12px;
        overflow: hidden;
        padding: 8px 12px;
        border-bottom: var(--border-inline) solid var(--border-color);
        background: var(--color-surface-raised);
        font-family: var(--ui-font);
    }

    .sidebar-header.left,
    .sidebar-header.right {
        padding: 10px 12px;
    }

    .sidebar-header-content {
        flex: 1;
        min-width: 0;
    }

    h2 {
        margin: 0;
        color: var(--text-color);
        font-size: var(--font-size-lg);
        font-family: var(--ui-font);
        font-weight: 700;
    }

    @media (--compact) {
        .sidebar-header.left,
        .sidebar-header.right {
            padding-right: calc(12px + env(safe-area-inset-right));
            padding-left: calc(12px + env(safe-area-inset-left));
        }
    }

    @media (--tiny-mobile) {
        .sidebar-header {
            height: calc(58px + env(safe-area-inset-top));
            min-height: calc(58px + env(safe-area-inset-top));
            gap: 8px;
            border-bottom-width: var(--border-inline);
        }

        .sidebar-header.left,
        .sidebar-header.right {
            padding: calc(10px + env(safe-area-inset-top)) calc(12px + env(safe-area-inset-right))
                10px calc(12px + env(safe-area-inset-left));
        }
    }

    @media (max-height: 500px) and (min-width: 481px) {
        .sidebar-header {
            height: 48px;
        }
    }
</style>
