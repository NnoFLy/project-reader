<script lang="ts">
    import * as m from "$lib/paraglide/messages"
    import { interfaceFontFamily, interfaceFontScale } from "$lib/core/settings/interfaceTypography"

    let { preset, customFamily, size }: { preset: unknown; customFamily: unknown; size: unknown } =
        $props()
    let family = $derived(interfaceFontFamily(preset, customFamily))
    let scale = $derived(interfaceFontScale(size))
</script>

<aside class="font-preview" aria-label={m.settings_ui_font_preview_label()}>
    <div class="preview-caption">
        <span>{m.settings_ui_font_preview_label()}</span>
        <span class="preview-size">{Math.round(scale * 100)}%</span>
    </div>
    <div class="sample" style:font-family={family} style:--preview-scale={scale}>
        <p class="sample-title">{m.settings_ui_font_preview_title()}</p>
        <p class="sample-body">{m.settings_ui_font_preview_body()}</p>
        <p class="sample-characters">Aa Бб Вв · 0123456789</p>
    </div>
    <p class="preview-note">{m.settings_ui_font_preview_note()}</p>
</aside>

<style>
    .font-preview {
        margin-block: var(--space-4) var(--space-2);
        padding: var(--space-4);
        border: 1px solid var(--border-color);
        border-radius: var(--radius-md);
        background: var(--surface-color);
        overflow-wrap: anywhere;
    }

    p {
        margin: 0;
    }

    .preview-caption {
        display: flex;
        justify-content: space-between;
        align-items: baseline;
        gap: var(--space-3);
        color: var(--faded-text-color);
        font-size: var(--font-size-xs);
    }

    .preview-size {
        font-family: var(--ui-mono-font);
        font-variant-numeric: tabular-nums;
    }

    .sample {
        display: grid;
        gap: var(--space-2);
        padding-block: var(--space-4);
        line-height: 1.55;
    }

    .sample-title {
        font-size: calc(1.25rem * var(--preview-scale));
        font-weight: 600;
        line-height: 1.3;
    }

    .sample-body,
    .sample-characters {
        font-size: calc(0.875rem * var(--preview-scale));
    }

    .sample-characters {
        color: var(--faded-text-color);
    }

    .preview-note {
        padding-top: var(--space-3);
        border-top: 1px solid var(--border-color);
        font-size: var(--font-size-xs);
        line-height: 1.5;
        color: var(--faded-text-color);
    }
</style>
