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
    .button {
        --button-height: var(--control-height-compact);
        display: inline-flex;
        position: relative;
        align-items: center;
        justify-content: center;
        box-sizing: border-box;
        gap: var(--control-gap);
        min-height: var(--button-height);
        padding: 6px var(--control-padding-inline);
        border: 1px solid transparent;
        border-radius: 999px;
        background: transparent;
        color: var(--btn-text, var(--text-color));
        font-family: var(--ui-font);
        font-size: var(--font-size-base);
        font-weight: 500;
        line-height: 1.3;
        text-align: center;
        text-decoration: none;
        white-space: nowrap;
        cursor: pointer;
        user-select: none;
        transition:
            background-color 120ms ease,
            color 120ms ease,
            transform 120ms ease;
    }

    .brutalist-btn {
        border-color: var(--color-control-border);
        background: var(--surface-color);
    }

    .fab-btn {
        --button-height: 44px;
        width: 44px;
        padding: 0;
        background: var(--surface-color);
    }

    .button.square {
        flex: 0 0 var(--button-height);
        width: var(--button-height);
        height: var(--button-height);
        padding: 0 !important;
    }

    .button :global(svg) {
        flex-shrink: 0;
        width: 18px;
        height: 18px;
        stroke-width: 1.75;
    }

    @media (hover: hover) {
        .button:hover:not(:disabled) {
            background: var(--surface-hover-color);
        }
    }

    .button:active:not(:disabled) {
        transform: scale(0.97);
    }

    .button.active,
    .button.open {
        background: var(--active-color);
        color: var(--active-text-color);
    }

    .button:focus-visible {
        outline: 2px solid var(--focus-color);
        outline-offset: 2px;
        z-index: var(--z-above);
    }

    .button:disabled {
        background: var(--disabled-bg-color);
        color: var(--color-on-disabled);
        cursor: not-allowed;
    }

    .small-size {
        --button-height: 32px;
    }

    .large-size {
        --button-height: 44px;
        padding-inline: 20px;
    }

    .none-btn,
    .size-none {
        min-height: 0;
        min-width: 0;
        padding: 0;
        border: 0;
        border-radius: 0;
    }

    @media (--mobile-width) {
        .button:not(.size-none):not(.none-btn) {
            --button-height: var(--control-height-regular);
            min-height: var(--button-height);
        }
    }
</style>
