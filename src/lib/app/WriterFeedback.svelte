<script lang="ts">
    import type { WriterApplicationState } from "./writerApplication"

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
        idle: [
            "Checking Library availability",
            "This window will open only when the Library is safe to use.",
        ],
        acquiring: [
            "Checking Library availability",
            "Checking whether another window is using this Library.",
        ],
        starting: [
            "Opening your Library",
            "Restoring your Library before enabling reading and editing.",
        ],
        running: ["Library is ready", ""],
        blocked: [
            "Library is open in another window",
            "Use the window that already has this Library open, or close it and try again here. This window cannot edit or save reading data.",
        ],
        unsupported: [
            "This browser cannot safely open the Library",
            "Exclusive access is unavailable. Use a browser with Web Locks support in a secure context, then try again. No Library editing has started.",
        ],
        failed: [
            "Library could not start safely",
            "Reading and editing are disabled. Try again, or reload this page. Your existing Library has not been reset.",
        ],
        stopping: [
            "Closing this Library",
            "Reading and editing are disabled while this window releases its work safely.",
        ],
        stopped: [
            "Library is closed",
            "Try again to open this Library with a fresh writer lifetime.",
        ],
        "recovery-required": [
            "Library needs a safe restart",
            "Reading and editing are disabled. This window may still be finishing storage work; it will not force another writer to take over. Reload this page, or close this window before retrying elsewhere.",
        ],
    } satisfies Record<WriterApplicationState, readonly [string, string]>
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
            <h1 id="writer-heading">{message[0]}</h1>
            <p>{message[1]}</p>
        </section>
        <div class="writer-actions">
            <button
                type="button"
                aria-disabled={!canRetry}
                onclick={() => {
                    if (canRetry) retry()
                }}>Try again</button
            >
            <button type="button" class="secondary" onclick={reload}>Reload page</button>
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
