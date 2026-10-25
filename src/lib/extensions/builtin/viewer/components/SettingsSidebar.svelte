<script lang="ts">
    import * as m from "$lib/paraglide/messages"
    import PlusIcon from "$lib/shared/icons/PlusIcon.svelte"
    import MinusIcon from "$lib/shared/icons/MinusIcon.svelte"
    import SinglePageIcon from "$lib/shared/icons/SinglePageIcon.svelte"
    import SplitPagesIcon from "$lib/shared/icons/SplitPagesIcon.svelte"
    import ScrollPagesIcon from "$lib/shared/icons/ScrollPagesIcon.svelte"
    import { getViewerRuntimeContext } from "../viewerRuntime"
    import { commandsStore } from "$lib/core/commands"

    const { store: viewerStore, executeCommand, settings } = getViewerRuntimeContext()()
    const uid = $props.id()
    const qualities = settings
        ? Array.from(
              { length: settings.CONSTANTS.maxQuality - settings.CONSTANTS.minQuality + 1 },
              (_, index) => settings.CONSTANTS.minQuality + index,
          )
        : []
    const canFitWidth = $derived(commandsStore.canExecute("viewer.zoom.fit-width"))

    function handleScaleChange(e: Event) {
        const input = e.target as HTMLInputElement
        const value = parseInt(input.value, 10)
        if (!isNaN(value)) {
            const clamped = Math.max(25, Math.min(500, value))
            executeCommand("settings.zoom.in", { value: clamped / 100 })
            input.value = clamped.toString()
        } else {
            input.value = Math.round(viewerStore.scale * 100).toString()
        }
    }

    function handleKeyDown(e: KeyboardEvent) {
        if (e.key === "Enter") {
            ;(e.target as HTMLInputElement).blur()
        }
    }
</script>

<div class="sidebar-content">
    <section class="settings-section">
        <h4 class="section-title">{m.layout()}</h4>
        <div class="layout-options" role="group" aria-label={m.layout()}>
            <button
                type="button"
                class={["option-btn", { active: viewerStore.layout === "single" }]}
                onclick={() => executeCommand("settings.layout", { value: "single" })}
                aria-pressed={viewerStore.layout === "single"}
            >
                <SinglePageIcon />
                <span>{m.single_page()}</span>
            </button>
            <button
                type="button"
                class={["option-btn", { active: viewerStore.layout === "split" }]}
                onclick={() => executeCommand("settings.layout", { value: "split" })}
                aria-pressed={viewerStore.layout === "split"}
            >
                <SplitPagesIcon />
                <span>{m.split_pages()}</span>
            </button>
            <button
                type="button"
                class={["option-btn", { active: viewerStore.layout === "scroll" }]}
                onclick={() => executeCommand("settings.layout", { value: "scroll" })}
                aria-pressed={viewerStore.layout === "scroll"}
            >
                <ScrollPagesIcon />
                <span>{m.scroll_pages()}</span>
            </button>
        </div>
    </section>

    <section class="settings-section">
        <h4 class="section-title">{m.zoom_scale()}</h4>
        <div class="range-control">
            <div class="zoom-controls" role="group" aria-label={m.zoom_scale()}>
                <button
                    type="button"
                    onclick={() => executeCommand("settings.zoom.out")}
                    aria-label={m.zoom_out()}
                    class="zoom-btn"
                >
                    <MinusIcon />
                </button>
                <div class="scale-input-container">
                    <input
                        type="number"
                        value={Math.round(viewerStore.scale * 100)}
                        onchange={handleScaleChange}
                        onkeydown={handleKeyDown}
                        min={25}
                        max={500}
                        class="scale-input"
                        aria-label={m.zoom_scale()}
                    />
                    <span class="percent-sign">%</span>
                </div>
                <button
                    type="button"
                    onclick={() => executeCommand("settings.zoom.in")}
                    aria-label={m.zoom_in()}
                    class="zoom-btn"
                >
                    <PlusIcon />
                </button>
            </div>
            <div class="slider-container">
                <input
                    type="range"
                    min={25}
                    max={500}
                    step="5"
                    value={Math.round(viewerStore.scale * 100)}
                    oninput={(e) => {
                        const val = parseInt((e.target as HTMLInputElement).value, 10)
                        if (!isNaN(val)) {
                            executeCommand("settings.zoom.in", { value: val / 100 })
                        }
                    }}
                    class="sidebar-slider"
                    aria-label={m.zoom_slider_aria()}
                />
            </div>
        </div>
        <button
            type="button"
            class="fit-width-btn"
            disabled={!canFitWidth}
            onclick={() => void commandsStore.execute("viewer.zoom.fit-width")}
        >
            {m.keymap_zoom_to_fit()}
        </button>
    </section>

    {#if settings}
        <section class="settings-section">
            <div class="control-row">
                <h4 class="section-title">
                    <label for={`${uid}-quality`}>{m.quality()}</label>
                </h4>
                <select
                    id={`${uid}-quality`}
                    value={settings.settingsStore.quality}
                    aria-describedby={`${uid}-quality-description`}
                    onchange={(event) =>
                        void executeCommand("settings.quality.in", {
                            value: Number(event.currentTarget.value),
                        })}
                >
                    {#each qualities as quality (quality)}
                        <option value={quality}>{quality}</option>
                    {/each}
                </select>
            </div>
            <p class="description" id={`${uid}-quality-description`}>
                {m.settings_quality_description()}
            </p>
        </section>

        <section class="settings-section">
            <h4 class="section-title">{m.settings_appearance()}</h4>
            <label class="control-row checkbox-row">
                <span>{m.animations()}</span>
                <input
                    type="checkbox"
                    checked={settings.settingsStore.animations}
                    aria-describedby={`${uid}-animations-description`}
                    onchange={() => void executeCommand("settings.animations.toggle")}
                />
            </label>
            <p class="description" id={`${uid}-animations-description`}>
                {m.settings_animations_description()}
            </p>
        </section>
    {/if}

    <div class="settings-footer">
        <button
            type="button"
            class="all-settings-btn"
            onclick={() => void executeCommand("settings.open")}
        >
            {m.settings_open()}
        </button>
    </div>
</div>

<style>
    .sidebar-content {
        display: flex;
        flex: 1;
        min-height: 0;
        min-width: 0;
        flex-direction: column;
        gap: var(--space-5);
        overflow-y: auto;
        overscroll-behavior: contain;
        padding: var(--space-4) var(--space-4)
            calc(var(--space-4) + var(--sidebar-safe-area-end, 0px));
        color: var(--text-color);
        font-family: var(--ui-font);
        font-size: var(--font-size-base);
    }

    .settings-section {
        display: flex;
        flex: none;
        flex-direction: column;
        gap: var(--space-2);
    }

    .settings-section + .settings-section {
        border-block-start: 1px solid var(--border-color);
        padding-block-start: var(--space-4);
    }

    .section-title {
        margin: 0;
        color: var(--faded-text-color);
        font-size: var(--font-size-base);
        font-weight: 500;
        line-height: 1.4;
    }

    button,
    select {
        min-height: var(--control-height-regular);
        border: 1px solid var(--color-control-border);
        border-radius: var(--radius-sm);
        padding: var(--space-2) var(--space-3);
        background: var(--surface-color);
        color: var(--text-color);
        font: inherit;
    }

    button {
        cursor: pointer;
    }

    button:disabled {
        cursor: not-allowed;
        color: var(--color-on-disabled);
        background: var(--color-disabled);
    }

    button:focus-visible,
    input:focus-visible,
    select:focus-visible {
        outline: 2px solid var(--focus-color);
        outline-offset: 2px;
    }

    @media (hover: hover) {
        button:hover:not(:disabled) {
            background: var(--surface-hover-color);
        }
    }

    .layout-options {
        display: flex;
        flex-direction: column;
        gap: var(--space-1);
    }

    .option-btn {
        display: flex;
        align-items: center;
        gap: var(--space-3);
        border-color: transparent;
        text-align: start;
    }

    .option-btn :global(svg) {
        flex: none;
        width: 20px;
        height: 20px;
    }

    .option-btn.active {
        background: var(--active-color);
        color: var(--active-text-color);
    }

    .option-btn[aria-pressed="true"]::after {
        content: "✓";
        margin-inline-start: auto;
        font-weight: 700;
    }

    .range-control {
        display: flex;
        flex-direction: column;
        gap: var(--space-1);
    }

    .zoom-controls {
        display: grid;
        grid-template-columns: var(--control-height-regular) minmax(0, 1fr) var(
                --control-height-regular
            );
        align-items: center;
        gap: var(--space-2);
    }

    .zoom-btn {
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 0;
    }

    .zoom-btn :global(svg) {
        width: 18px;
        height: 18px;
    }

    .scale-input-container {
        display: flex;
        align-items: center;
        justify-content: center;
        min-width: 0;
        min-height: var(--control-height-regular);
        border: 1px solid var(--color-control-border);
        border-radius: var(--radius-sm);
        background: var(--surface-color);
        font-variant-numeric: tabular-nums;
    }

    .scale-input {
        width: 4ch;
        min-height: var(--control-height-regular);
        border: 0;
        padding: 0;
        background: transparent;
        color: inherit;
        font: inherit;
        text-align: end;
        appearance: textfield;
        -moz-appearance: textfield;
    }

    .scale-input::-webkit-outer-spin-button,
    .scale-input::-webkit-inner-spin-button {
        -webkit-appearance: none;
        margin: 0;
    }

    .percent-sign {
        margin-inline-start: var(--space-1);
    }

    .slider-container {
        display: flex;
        align-items: center;
    }

    .sidebar-slider {
        width: 100%;
        min-height: var(--control-height-regular);
        margin: 0;
        accent-color: var(--accent-color);
        cursor: pointer;
    }

    .control-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: var(--space-3);
    }

    select {
        flex: none;
        min-width: 4.5rem;
    }

    .checkbox-row {
        min-height: var(--control-height-regular);
        cursor: pointer;
    }

    input[type="checkbox"] {
        flex: none;
        width: 20px;
        height: 20px;
        margin: 0;
        accent-color: var(--accent-color);
    }

    .description {
        margin: 0;
        color: var(--faded-text-color);
        font-size: var(--font-size-sm);
        line-height: 1.5;
    }

    .settings-footer {
        flex: none;
        margin-block-start: auto;
        border-block-start: 1px solid var(--border-color);
        padding-block-start: var(--space-4);
    }

    .all-settings-btn {
        width: 100%;
        border-color: transparent;
        background: var(--primary-color);
        color: var(--primary-text-color);
        font-weight: 500;
        white-space: normal;
    }

    @media (hover: hover) {
        .all-settings-btn:hover:not(:disabled) {
            background: var(--primary-color);
            text-decoration: underline;
        }
    }

    @media (forced-colors: active) {
        .option-btn[aria-pressed="true"] {
            outline: 2px solid Highlight;
            outline-offset: -3px;
        }
    }
</style>
