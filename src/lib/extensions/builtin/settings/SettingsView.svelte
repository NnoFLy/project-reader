<script lang="ts">
    import { settingsStore } from "./state/settingsStore.svelte"

    const themes = ["system", "light", "dark"] as const
    const layouts = ["scroll", "single", "split"] as const
    const languages = ["ru", "en"] as const
    const qualities = [1, 2, 3, 4, 5] as const
</script>

<section class="settings-view" aria-label="Settings">
    <h2>Settings</h2>
    {#if settingsStore.isRegistered("settings.theme")}
        <label>
            Theme
            <select bind:value={settingsStore.theme}>
                {#each themes as theme}
                    <option value={theme}>{theme}</option>
                {/each}
            </select>
        </label>
    {/if}
    {#if settingsStore.isRegistered("settings.layout")}
        <label>
            Layout
            <select bind:value={settingsStore.layout}>
                {#each layouts as layout}
                    <option value={layout}>{layout}</option>
                {/each}
            </select>
        </label>
    {/if}
    {#if settingsStore.isRegistered("settings.scale")}
        <label>
            Scale
            <input
                type="range"
                min="25"
                max="500"
                step="5"
                value={Math.round(settingsStore.scale * 100)}
                oninput={(event) =>
                    (settingsStore.scale = Number(event.currentTarget.value) / 100)}
            />
            <output>{Math.round(settingsStore.scale * 100)}%</output>
        </label>
    {/if}
    {#if settingsStore.isRegistered("settings.quality")}
        <label>
            Quality
            <select bind:value={settingsStore.quality}>
                {#each qualities as quality}
                    <option value={quality}>{quality}</option>
                {/each}
            </select>
        </label>
    {/if}
    {#if settingsStore.isRegistered("settings.language")}
        <label>
            Language
            <select bind:value={settingsStore.language}>
                {#each languages as language}
                    <option value={language}>{language}</option>
                {/each}
            </select>
        </label>
    {/if}
    {#if settingsStore.isRegistered("settings.animations")}
        <label>
            <span>Animations</span>
            <input type="checkbox" bind:checked={settingsStore.animations} />
        </label>
    {/if}
    {#if settingsStore.isRegistered("settings.prefer-pdf-title")}
        <label>
            <span>Prefer PDF title</span>
            <input type="checkbox" bind:checked={settingsStore.preferPdfTitle} />
        </label>
    {/if}
</section>

<style>
    .settings-view {
        display: flex;
        flex-direction: column;
        gap: 1rem;
        padding: 1rem;
    }

    label {
        display: flex;
        gap: 0.5rem;
        align-items: center;
        justify-content: space-between;
    }

    input[type="range"] {
        flex: 1;
    }
</style>
