<script lang="ts">
    import type { WriterApplicationState } from "./writerApplication"
    import * as m from "$lib/paraglide/messages"

    let {
        state,
        retry,
        reload,
    }: {
        state: WriterApplicationState
        retry: () => void
        reload: () => void
    } = $props()

    const messages = {
        idle: [m.writer_checking_title, m.writer_idle_description],
        acquiring: [m.writer_checking_title, m.writer_acquiring_description],
        starting: [m.writer_starting_title, m.writer_starting_description],
        running: [m.writer_ready_title, () => ""],
        blocked: [m.writer_blocked_title, m.writer_blocked_description],
        unsupported: [m.writer_unsupported_title, m.writer_unsupported_description],
        failed: [m.writer_failed_title, m.writer_failed_description],
        stopping: [m.writer_stopping_title, m.writer_stopping_description],
        stopped: [m.writer_stopped_title, m.writer_stopped_description],
        "recovery-required": [m.writer_recovery_title, m.writer_recovery_description],
    } satisfies Record<WriterApplicationState, readonly [() => string, () => string]>
    let message = $derived(messages[state])
    let canRetry = $derived(["blocked", "unsupported", "failed", "stopped"].includes(state))
</script>

<main class="writer-feedback" data-writer-state={state}>
    <div class="writer-message">
        <section
            role="status"
            aria-live="polite"
            aria-atomic="true"
            aria-labelledby="writer-heading"
        >
            <h1 id="writer-heading">{message[0]()}</h1>
            <p>{message[1]()}</p>
        </section>
        <div class="writer-actions">
            <button
                type="button"
                aria-disabled={!canRetry}
                onclick={() => {
                    if (canRetry) retry()
                }}>{m.writer_retry()}</button
            >
            <button type="button" class="secondary" onclick={reload}>{m.writer_reload()}</button>
        </div>
    </div>
</main>

<style>
    .writer-feedback {
        min-height: 100dvh;
        display: grid;
        align-items: center;
        padding: var(--space-5);
        box-sizing: border-box;
        background: var(--color-canvas);
        color: var(--color-text);
    }
    .writer-message {
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
    .writer-actions {
        display: flex;
        flex-wrap: wrap;
        gap: var(--space-3);
        margin-block-start: var(--space-5);
    }
    button {
        min-height: var(--control-height-regular);
        padding: var(--space-3) var(--space-4);
        border: 1px solid var(--color-control-border);
        border-radius: var(--radius-sm);
        background: var(--color-action);
        color: var(--color-on-action);
        font: inherit;
        cursor: pointer;
    }
    button.secondary {
        background: var(--color-surface);
        color: var(--color-text);
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
        .writer-feedback {
            padding: var(--space-4);
        }
        h1 {
            font-size: var(--font-size-3xl);
        }
    }
</style>
