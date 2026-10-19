<script lang="ts">
    import * as m from "$lib/paraglide/messages"
    import { appUpdate } from "$lib/shared/state/appUpdate.svelte"
    import Button from "$lib/shared/ui/Button.svelte"
</script>

{#if appUpdate.available}
    <Button
        class="app-update-button"
        variant="action"
        size="small"
        disabled={appUpdate.updating}
        onclick={() => void appUpdate.update()}
        aria-label={appUpdate.updating ? m.updating_app() : m.update_app()}
        tooltip={m.new_version_description()}
    >
        <span class="status-dot" aria-hidden="true"></span>
        <span>{appUpdate.updating ? m.updating_app() : m.update_app()}</span>
    </Button>
{/if}

<style>
    :global(.app-update-button) {
        flex: none;
        color: var(--text-color) !important;
        background: var(--surface-hover-color) !important;
        white-space: nowrap;
    }

    :global(.app-update-button:hover:not(:disabled)) {
        background: var(--active-color) !important;
    }

    .status-dot {
        width: 0.55rem;
        height: 0.55rem;
        background: currentColor;
        border-radius: 50%;
    }

    @media (--tiny-mobile) {
        :global(.app-update-button) {
            padding-inline: 0.55rem !important;
        }

        .status-dot {
            display: none;
        }
    }
</style>
