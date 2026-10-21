<script lang="ts">
    let {
        checked = $bindable(false),
        label = "",
        disabled = false,
        id = `toggle-${Math.random().toString(36).slice(2, 9)}`,
        onchange,
    } = $props<{
        checked?: boolean
        label?: string
        disabled?: boolean
        id?: string
        onchange?: (checked: boolean) => void
    }>()

    function handleChange() {
        onchange?.(checked)
    }
</script>

<div class="toggle-container" class:disabled>
    <label for={id} class="toggle-label-wrapper">
        <input
            type="checkbox"
            {id}
            bind:checked
            {disabled}
            class="toggle-input"
            onchange={handleChange}
        />
        <span class="toggle-track">
            <span class="toggle-thumb"></span>
        </span>
        {#if label}
            <span class="toggle-label-text">{label}</span>
        {/if}
    </label>
</div>

<style>
    .toggle-container {
        display: inline-flex;
        align-items: center;
        user-select: none;
    }

    .toggle-label-wrapper {
        position: relative;
        display: flex;
        min-block-size: var(--control-height-compact);
        align-items: center;
        gap: var(--space-3);
        color: var(--text-color);
        font-family: var(--ui-font);
        font-size: var(--font-size-base);
        font-weight: 700;
        cursor: pointer;
    }

    .toggle-input {
        position: absolute;
        width: 1px;
        height: 1px;
        padding: 0;
        margin: -1px;
        overflow: hidden;
        clip-path: inset(50%);
        white-space: nowrap;
        border: 0;
    }

    .toggle-track {
        --toggle-inset: 3px;
        --toggle-thumb-size: 16px;
        position: relative;
        display: inline-block;
        width: 44px;
        height: 24px;
        flex: 0 0 auto;
        box-sizing: border-box;
        border: var(--border-inline) solid var(--border-color);
        background: var(--surface-color);
        box-shadow: var(--shadow-inline);
        transition:
            background-color 0.15s ease,
            border-color 0.15s ease,
            box-shadow 0.15s ease;
    }

    .toggle-thumb {
        position: absolute;
        top: var(--toggle-inset);
        left: var(--toggle-inset);
        width: var(--toggle-thumb-size);
        height: var(--toggle-thumb-size);
        box-sizing: border-box;
        border: 1px solid var(--border-color);
        background: var(--text-color);
        transition:
            transform 0.18s cubic-bezier(0.2, 0.8, 0.2, 1),
            background-color 0.15s ease;
    }

    .toggle-input:checked + .toggle-track {
        border-color: var(--accent-active-color);
        background: var(--selected-surface);
    }

    .toggle-input:checked + .toggle-track .toggle-thumb {
        transform: translateX(
            calc(
                44px - (2 * var(--border-inline)) - (2 * var(--toggle-inset)) -
                    var(--toggle-thumb-size)
            )
        );
        background: var(--accent-active-color);
    }

    .toggle-input:focus-visible + .toggle-track {
        outline: none;
        box-shadow: var(--focus-ring);
    }

    @media (hover: hover) {
        .toggle-label-wrapper:hover .toggle-track {
            background: var(--surface-hover-color);
        }

        .toggle-label-wrapper:hover .toggle-input:checked + .toggle-track {
            background: color-mix(in srgb, var(--accent-active-color) 28%, var(--surface-color));
        }
    }

    .toggle-label-wrapper:active .toggle-track {
        background: var(--faded-color);
    }

    .disabled {
        opacity: 0.45;
    }

    .disabled .toggle-label-wrapper {
        cursor: not-allowed;
    }

    @media (forced-colors: active) {
        .toggle-input:focus-visible + .toggle-track {
            outline: 2px solid Highlight;
            outline-offset: 2px;
        }
    }

    @media (--mobile-width) {
        .toggle-label-wrapper {
            min-block-size: var(--control-height-regular);
        }
    }
</style>
