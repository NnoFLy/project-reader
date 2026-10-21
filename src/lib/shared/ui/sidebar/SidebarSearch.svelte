<script lang="ts">
    import type { HTMLInputAttributes } from "svelte/elements"
    import Input from "../Input.svelte"
    import SearchIcon from "$lib/shared/icons/SearchIcon.svelte"
    import { focusLeavesSearchControl } from "./sidebarSearchFocus"

    interface Props extends Omit<HTMLInputAttributes, "value" | "type"> {
        value?: string
        ref?: HTMLInputElement | null
        focused?: boolean
        clearLabel?: string
        onClear?: () => void
    }

    let {
        value = $bindable(""),
        ref = $bindable(null),
        focused = $bindable(false),
        clearLabel = "Clear search",
        onClear,
        class: className = "",
        ...inputProps
    }: Props = $props()

    function clear() {
        value = ""
        onClear?.()
        ref?.focus()
    }
</script>

<div
    class={["sidebar-search", className]}
    role="search"
    onfocusin={() => (focused = true)}
    onfocusout={(event) => {
        if (focusLeavesSearchControl(event.currentTarget, event.relatedTarget)) focused = false
    }}
>
    <SearchIcon class="sidebar-search-icon" aria-hidden="true" />
    <Input
        unstyled
        bind:ref
        type="search"
        bind:value
        class="sidebar-search-input"
        {...inputProps}
    />
    {#if value}
        <button class="sidebar-search-clear" type="button" onclick={clear} aria-label={clearLabel}>
            ×
        </button>
    {/if}
</div>

<style>
    .sidebar-search {
        position: relative;
        z-index: var(--z-5);
        display: flex;
        flex-shrink: 0;
        align-items: center;
        box-sizing: border-box;
        border-block-end: var(--border-inline) solid var(--border-color);
        background: var(--surface-color);
        font-family: var(--ui-font);
    }

    .sidebar-search :global(.sidebar-search-icon) {
        position: absolute;
        inset-inline-start: 14px;
        inline-size: 18px;
        block-size: 18px;
        color: var(--faded-text-color);
        pointer-events: none;
    }

    .sidebar-search :global(.sidebar-search-input) {
        inline-size: 100%;
        box-sizing: border-box;
        padding-block: var(--space-3);
        padding-inline: 42px 36px;
        border: 0;
        outline: 0;
        background: var(--surface-color);
        color: var(--text-color);
        font-family: var(--ui-font);
        font-weight: 600;
        transition:
            background-color 0.15s ease,
            box-shadow 0.15s ease;
        appearance: none;
    }

    .sidebar-search :global(.sidebar-search-input::-webkit-search-cancel-button) {
        display: none;
    }

    .sidebar-search :global(.sidebar-search-input:focus) {
        background: color-mix(in srgb, var(--accent-color) 6%, var(--surface-color));
        box-shadow: inset 3px 0 0 var(--accent-color);
    }

    .sidebar-search-clear {
        position: absolute;
        top: 50%;
        inset-inline-end: 12px;
        display: flex;
        inline-size: 18px;
        block-size: 18px;
        align-items: center;
        justify-content: center;
        padding: 0;
        transform: translateY(-50%);
        cursor: pointer;
        border: 0;
        border-radius: var(--radius-full);
        background: var(--faded-color);
        color: var(--text-color);
        font-size: var(--font-size-sm);
        font-weight: 800;
        line-height: 1;
        opacity: 0.6;
        transition:
            opacity 0.15s ease,
            background-color 0.15s ease,
            color 0.15s ease;
    }

    .sidebar-search-clear:focus-visible {
        outline: 2px solid var(--accent-color);
        outline-offset: 2px;
        opacity: 1;
    }

    @media (hover: hover) {
        .sidebar-search-clear:hover {
            background: var(--border-color);
            color: var(--surface-color);
            opacity: 1;
        }
    }

    @media (forced-colors: active) {
        .sidebar-search :global(.sidebar-search-input:focus-visible) {
            outline: 2px solid Highlight;
            outline-offset: -2px;
        }
    }

    @media (max-width: 640px) {
        .sidebar-search {
            border-block-end-width: 1px;
        }

        .sidebar-search :global(.sidebar-search-input) {
            min-block-size: 48px;
            padding: 11px 42px;
            font-size: max(1rem, var(--font-size-input));
        }

        .sidebar-search :global(.sidebar-search-icon) {
            inset-inline-start: 14px;
        }

        .sidebar-search-clear {
            inset-inline-end: 8px;
            inline-size: 32px;
            block-size: 32px;
        }
    }
</style>
