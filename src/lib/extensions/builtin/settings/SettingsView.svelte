<script lang="ts">
    import { settingsStore } from "$lib/modules/settings"

    const themes = ["system", "light", "dark"] as const
</script>

<section class="settings-view" aria-label="Settings">
    <h2>Settings</h2>
    <label>
        Theme
        <select bind:value={settingsStore.theme}>
            {#each themes as theme}
                <option value={theme}>{theme}</option>
            {/each}
        </select>
    </label>
    <label>
        <input type="checkbox" bind:checked={settingsStore.animations} />
        Animations
    </label>
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
</style>
