<script lang="ts">
    import { settingsStore } from "$lib/modules/settings"
    import { fade, scale } from "svelte/transition"
    import { backOut } from "svelte/easing"

    interface Props {
        onSelect: () => void
        keyChar: string
    }

    let { keyChar, onSelect }: Props = $props()
</script>

<button
    type="button"
    class="picker-key"
    onclick={onSelect}
    transition:fade={{ duration: settingsStore.animations ? 120 : 0 }}
>
    <kbd
        transition:scale={{
            duration: settingsStore.animations ? 200 : 0,
            start: 0.7,
            easing: backOut,
        }}
    >
        {keyChar}
    </kbd>
</button>

<style>
    .picker-key {
        position: absolute;
        inset: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: var(--z-10);
        cursor: pointer;
        transition: background-color 0.2s cubic-bezier(0.4, 0, 0.2, 1);
        background: none;
        border: none;
        padding: 0;
        margin: 0;
        outline: none;
        appearance: none;
    }

    .picker-key:focus-visible {
        outline: 2px solid var(--accent-active-color);
        outline-offset: -2px;
    }

    kbd {
        font-family: var(--font-mono, Menlo, Monaco, Consolas, "Courier New", monospace);
        font-size: var(--font-size-4xl);
        font-weight: 900;
        text-transform: uppercase;
        background: var(--accent-active-color);
        color: var(--text-color);
        border: 3px solid var(--border-color);
        box-shadow: 4px 4px 0 var(--border-color);
        border-radius: 8px;
        width: auto;
        min-width: 56px;
        height: 56px;
        padding: 0 12px;
        box-sizing: border-box;
        display: flex;
        align-items: center;
        justify-content: center;
        pointer-events: none;
        transition:
            transform 0.15s cubic-bezier(0.4, 0, 0.2, 1),
            box-shadow 0.15s cubic-bezier(0.4, 0, 0.2, 1);
    }

    @media (hover: hover) {
        .picker-key:hover kbd {
            transform: translate(-2px, -2px);
            box-shadow: 6px 6px 0 var(--border-color);
        }
    }

    .picker-key:active kbd {
        transform: translate(2px, 2px);
        box-shadow: 2px 2px 0 var(--border-color);
    }
</style>
