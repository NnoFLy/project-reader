<script lang="ts">
    import type { Component, Snippet } from "svelte"
    import type { HTMLButtonAttributes } from "svelte/elements"
    import { resolve } from "$app/paths"
    import { tooltip as tooltipAction } from "$lib/shared/actions/tooltip"

    interface Props extends HTMLButtonAttributes {
        children?: Snippet
        Icon?: Component
        tooltip?: string
        tooltipAlign?: "left" | "right" | "center"
        variant?: "action" | "fab" | "brutalist" | "ghost" | "none" | "close"
        size?: "none" | "small" | "default" | "large"
        square?: boolean
        open?: boolean
        href?: string
        ref?: HTMLButtonElement | null
    }

    let {
        children,
        Icon,
        tooltip,
        tooltipAlign,
        title,
        variant = "action",
        size = "default",
        square = false,
        open = false,
        href,
        ref = $bindable(),
        class: className = "",
        ...props
    }: Props = $props()

    const displayTooltip = $derived(tooltip || title)

    function captureButton(node: HTMLButtonElement) {
        ref = node
        return () => {
            if (ref === node) ref = null
        }
    }
</script>

{#if href}
    <a
        href={resolve(href as any)}
        class={[
            "button",
            variant === "action" || variant === "close" ? "action-btn" : "",
            variant === "close" ? "close-btn" : "",
            variant === "fab" ? "fab-btn" : "",
            variant === "brutalist" ? "brutalist-btn" : "",
            variant === "ghost" ? "ghost-btn" : "",
            variant === "none" ? "none-btn" : "",
            size === "none" ? "size-none" : "",
            size === "small" ? "small-size" : "",
            size === "default" ? "default-size" : "",
            size === "large" ? "large-size" : "",
            square ? "square" : "",
            open ? "open" : "",
            className,
        ]
            .filter(Boolean)
            .join(" ")}
        use:tooltipAction={displayTooltip
            ? { text: displayTooltip, align: tooltipAlign }
            : undefined}
        {...props as any}
    >
        {#if Icon}
            <Icon />
        {/if}
        {@render children?.()}
    </a>
{:else}
    <button
        {@attach captureButton}
        class={[
            "button",
            variant === "action" || variant === "close" ? "action-btn" : "",
            variant === "close" ? "close-btn" : "",
            variant === "fab" ? "fab-btn" : "",
            variant === "brutalist" ? "brutalist-btn" : "",
            variant === "ghost" ? "ghost-btn" : "",
            variant === "none" ? "none-btn" : "",
            size === "none" ? "size-none" : "",
            size === "small" ? "small-size" : "",
            size === "default" ? "default-size" : "",
            size === "large" ? "large-size" : "",
            square ? "square" : "",
            open ? "open" : "",
            className,
        ]
            .filter(Boolean)
            .join(" ")}
        use:tooltipAction={displayTooltip
            ? { text: displayTooltip, align: tooltipAlign }
            : undefined}
        {...props}
    >
        {#if Icon}
            <Icon />
        {/if}
        {@render children?.()}
    </button>
{/if}

<style>
    .action-btn {
        display: inline-flex;
        position: relative;
        align-items: center;
        justify-content: center;
        box-sizing: border-box;
        gap: var(--control-gap);
        padding: 6px var(--control-padding-inline);
        border: var(--border-inline) solid var(--border-color, #1a1a1a);
        background: var(--surface-color, #ffffff);
        box-shadow: var(--shadow-inline);
        color: var(--btn-text, var(--text-color, #1a1a1a));
        font-family: var(--ui-font);
        font-size: var(--font-size-base);
        font-weight: 700;
        line-height: 1.2;
        text-align: center;
        cursor: pointer;
        user-select: none;
        transition:
            background-color 0.1s ease,
            border-color 0.1s ease,
            box-shadow 0.1s ease,
            transform 0.1s ease;
    }

    .button.square {
        padding: 0 !important;
        flex-shrink: 0 !important;
        display: inline-flex;
        align-items: center;
        justify-content: center;
    }

    @media (hover: hover) {
        .action-btn:hover:not(:disabled):not(:active):not(.active):not(.open) {
            transform: translate(-1px, -1px);
            background: var(--surface-hover-color);
            /* Counter the 1px lift so the shadow stays anchored. */
            box-shadow: 3px 3px 0 var(--shadow-color);
        }

        .action-btn.square:hover:not(:disabled):not(:active):not(.active):not(.open) {
            background: color-mix(in srgb, var(--accent-color) 18%, var(--surface-color));
        }
    }

    .action-btn:focus-visible {
        outline: none;
        box-shadow: var(--focus-ring);
        z-index: 110;
    }

    .action-btn:active:not(:disabled),
    .action-btn.active:not(:disabled),
    .action-btn.open:not(:disabled) {
        transform: translate(1px, 1px);
        background: var(--accent-active-color);
        border-color: var(--border-color);
        box-shadow: 0 0 0 var(--shadow-color);
    }

    .action-btn:disabled {
        opacity: 0.45;
        cursor: not-allowed;
        background: var(--disabled-bg-color);
    }

    .fab-btn {
        background: transparent;
        border: var(--border-elevated) solid var(--border-color, #1a1a1a);
        box-shadow: var(--shadow-elevated);
        display: inline-flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        z-index: var(--z-sticky);
        position: relative;
        box-sizing: border-box;
        transition:
            transform 0.1s ease,
            opacity 0.1s ease,
            box-shadow 0.1s ease,
            background-color 0.1s ease,
            color 0.1s ease;
        color: var(--btn-text, var(--text-color, #1a1a1a));
        padding: 0;
        width: 50px;
        min-height: 50px;
    }

    @media (hover: hover) {
        .fab-btn:hover:not(:disabled):not(:active):not(.active):not(.open) {
            color: var(--accent-color);
        }
    }

    .fab-btn:active:not(:disabled),
    .fab-btn.active:not(:disabled),
    .fab-btn.open {
        transform: translate(2px, 2px);
        box-shadow: 2px 2px 0 var(--shadow-color, var(--shadow-color, #1a1a1a));
        background: transparent;
    }

    @media (--mobile) {
        .fab-btn {
            border-width: 2px;
            box-shadow: 4px 4px 0 var(--shadow-color, var(--shadow-color, #1a1a1a));
        }
    }

    .brutalist-btn {
        background: var(--surface-color, #ffffff);
        border: 2px solid var(--border-color, #1a1a1a);
        box-shadow: var(--shadow-elevated);
        padding: 8px 16px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 8px;
        font-family: inherit;
        font-size: var(--font-size-lg);
        font-weight: bold;
        cursor: pointer;
        color: var(--btn-text, var(--text-color, #1a1a1a));
        position: relative;
        user-select: none;
        box-sizing: border-box;
        transition:
            background-color 0.1s ease,
            border-color 0.1s ease,
            box-shadow 0.1s ease,
            color 0.1s ease,
            transform 0.1s ease;
        line-height: 1.2;
        text-align: center;
    }

    @media (hover: hover) {
        .brutalist-btn:hover:not(:disabled):not(:active):not(.active):not(.open),
        .brutalist-btn:focus-visible:not(:disabled):not(:active):not(.active):not(.open) {
            transform: translate(-1px, -1px);
            /* Counter the 1px lift so the shadow stays anchored. */
            box-shadow: 5px 5px 0 var(--shadow-color);
            background: var(--accent-color, var(--surface-hover-color, #faf8f5));
            outline: none;
        }
    }

    .brutalist-btn:active:not(:disabled),
    .brutalist-btn.active:not(:disabled),
    .brutalist-btn.open {
        transform: translate(2px, 2px);
        box-shadow: 0px 0px 0 var(--shadow-color, var(--shadow-color, #1a1a1a));
        background: var(--accent-active-color, var(--accent-active-color, #eae6d8));
    }

    .ghost-btn {
        background: transparent;
        border: 2px solid transparent;
        padding: 8px 16px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 8px;
        font-family: inherit;
        font-size: var(--font-size-lg);
        font-weight: bold;
        cursor: pointer;
        color: var(--btn-text, var(--text-color, #1a1a1a));
        position: relative;
        user-select: none;
        box-sizing: border-box;
        transition:
            background-color 0.15s cubic-bezier(0.4, 0, 0.2, 1),
            border-color 0.15s cubic-bezier(0.4, 0, 0.2, 1),
            color 0.15s cubic-bezier(0.4, 0, 0.2, 1);
        line-height: 1.2;
        text-align: center;
    }

    @media (hover: hover) {
        .ghost-btn:hover:not(:disabled):not(:active):not(.active):not(.open),
        .ghost-btn:focus-visible:not(:disabled):not(:active):not(.active):not(.open) {
            background: var(--faded-color, var(--faded-color, rgba(0, 0, 0, 0.05)));
            outline: none;
        }
    }

    .ghost-btn:active:not(:disabled),
    .ghost-btn.active:not(:disabled),
    .ghost-btn.open {
        background: var(--faded-color, var(--faded-color, rgba(0, 0, 0, 0.1)));
    }

    .none-btn {
        background: transparent;
        border: none;
        padding: 0;
        cursor: pointer;
        color: inherit;
        font-family: inherit;
        font-size: inherit;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        position: relative;
        box-sizing: border-box;
    }

    .size-none {
        padding: 0 !important;
        min-width: 0 !important;
        min-height: 0 !important;
    }

    /* Hover/Focus Stacking Context */
    .button:focus-visible,
    .button:hover {
        z-index: 110;
    }

    .fab-btn:focus-visible,
    .brutalist-btn:focus-visible,
    .ghost-btn:focus-visible,
    .none-btn:focus-visible {
        outline: none;
        box-shadow: var(--focus-ring);
    }

    .action-btn :global(svg),
    .fab-btn :global(svg),
    .brutalist-btn :global(svg),
    .ghost-btn :global(svg) {
        stroke-width: 2.5;
    }

    .default-size {
        min-height: var(--control-height-compact);

        :global(svg) {
            width: 24px;
            height: 24px;
        }
    }

    .default-size.square {
        width: var(--control-height-compact);
        min-width: var(--control-height-compact);
        max-width: var(--control-height-compact);
        height: var(--control-height-compact);
        min-height: var(--control-height-compact);
        max-height: var(--control-height-compact);
    }

    .large-size {
        min-height: 48px;

        :global(svg) {
            width: 32px;
            height: 32px;
        }
    }

    .large-size.square {
        width: 48px;
        min-width: 48px;
        max-width: 48px;
        height: 48px;
        min-height: 48px;
        max-height: 48px;
    }

    .small-size {
        min-height: 28px;

        :global(svg) {
            width: 18px;
            height: 18px;
        }
    }

    .small-size.square {
        width: 28px;
        min-width: 28px;
        max-width: 28px;
        height: 28px;
        min-height: 28px;
        max-height: 28px;
    }

    .close-btn.square {
        width: var(--control-height-compact);
        min-width: var(--control-height-compact);
        max-width: var(--control-height-compact);
        height: var(--control-height-compact);
        min-height: var(--control-height-compact);
        max-height: var(--control-height-compact);
        line-height: 1;
    }

    .close-btn.square :global(svg) {
        width: 22px;
        height: 22px;
        stroke-width: 3;
    }

    @media (--mobile-width) {
        .default-size,
        .large-size,
        .small-size {
            min-height: var(--control-height-regular);
        }

        .default-size.square,
        .large-size.square,
        .small-size.square {
            width: var(--control-height-regular);
            min-width: var(--control-height-regular);
            max-width: var(--control-height-regular);
            height: var(--control-height-regular);
            min-height: var(--control-height-regular);
            max-height: var(--control-height-regular);
        }

        .default-size :global(svg),
        .large-size :global(svg),
        .small-size :global(svg) {
            width: 22px;
            height: 22px;
        }

        .close-btn.square {
            width: var(--control-height-regular);
            min-width: var(--control-height-regular);
            max-width: var(--control-height-regular);
            height: var(--control-height-regular);
            min-height: var(--control-height-regular);
            max-height: var(--control-height-regular);
        }
    }
</style>
