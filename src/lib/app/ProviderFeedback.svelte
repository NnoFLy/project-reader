<script lang="ts">
    import * as m from "$lib/paraglide/messages"

    let { retrying, retry }: { retrying: boolean; retry: () => void } = $props()
</script>

<main
    class="provider-feedback"
    data-provider-feedback={retrying ? "viewer.retrying" : "viewer.unavailable"}
>
    <div class="provider-message">
        <section
            role="status"
            aria-live="polite"
            aria-atomic="true"
            aria-labelledby="provider-heading"
        >
            <h1 id="provider-heading">{m.viewer_provider_unavailable_title()}</h1>
            <p>
                {retrying
                    ? m.viewer_provider_retrying()
                    : m.viewer_provider_unavailable_description()}
            </p>
        </section>
        <button
            type="button"
            aria-disabled={retrying}
            onclick={() => {
                if (!retrying) retry()
            }}>{retrying ? m.viewer_provider_retrying() : m.viewer_provider_retry()}</button
        >
    </div>
</main>

<style>
    .provider-feedback {
        flex: 1;
        min-height: 60dvh;
        display: grid;
        align-items: center;
        padding: var(--space-5);
        box-sizing: border-box;
        background: var(--color-canvas);
        color: var(--color-text);
    }
    .provider-message {
        width: 100%;
        max-width: 36rem;
        margin-inline: auto;
        border-block-start: 2px solid var(--color-control-border);
        padding-block: var(--space-6);
    }
    h1 {
        margin: 0 0 var(--space-4);
        font-size: var(--font-size-5xl);
        line-height: 1.2;
        font-weight: 600;
        overflow-wrap: anywhere;
    }
    p {
        margin: 0;
        max-width: 60ch;
        color: var(--color-text-muted);
        font-size: var(--font-size-lg);
        line-height: 1.6;
    }
    button {
        margin-block-start: var(--space-5);
        min-height: var(--control-height-regular);
        max-width: 100%;
        padding: var(--space-3) var(--space-4);
        border: 1px solid var(--color-control-border);
        border-radius: var(--radius-sm);
        background: var(--color-action);
        color: var(--color-on-action);
        font: inherit;
        overflow-wrap: anywhere;
        cursor: pointer;
    }
    button[aria-disabled="true"] {
        background: var(--color-disabled);
        color: var(--color-on-disabled);
        cursor: default;
    }
    button:focus-visible {
        outline: 2px solid var(--color-focus);
        outline-offset: 3px;
    }
    @media (max-width: 480px) {
        .provider-feedback {
            padding: var(--space-4);
        }
        h1 {
            font-size: var(--font-size-3xl);
        }
    }
</style>
