<script lang="ts">
    import { onMount } from "svelte"
    import * as m from "$lib/paraglide/messages"
    import Button from "$lib/shared/ui/Button.svelte"
    import { getViewerRuntimeContext } from "../viewerRuntime"
    const { store, executeCommand } = getViewerRuntimeContext()()
    const { documentId } = $props<{ documentId: string }>()
    let revision = $state(0)
    let busy = $state(false)
    let failed = $state(false)
    const records = $derived.by(() => {
        void revision
        return store.workspace.annotations(documentId)
    })
    const passages = $derived([
        ...records.notes.map((record) => ({ kind: "note", record })),
        ...records.drafts.map((record) => ({ kind: "draft", record })),
    ])
    onMount(() => store.workspace.subscribeAnnotations(() => revision++))
    async function retry() {
        if (busy) return
        busy = true
        try {
            failed = !(await executeCommand("library.reading.cleanup.retry"))
        } catch {
            failed = true
        } finally {
            busy = false
        }
    }
</script>

<section
    class="cleanup"
    role="status"
    aria-label={m.reading_cleanup_retry()}
    data-reading-state="deletion-pending"
>
    <h1>{m.reading_cleanup_retry()}</h1>
    <p>{m.reading_cleanup_pending()}</p>
    {#if failed}<p>{m.reading_cleanup_failed()}</p>{/if}
    <Button
        disabled={busy}
        onclick={() => void retry()}
        onkeydown={(event) => {
            // The mounted reader's Space shortcut must not consume native button activation.
            if (event.key === " " || event.key === "Enter") event.stopPropagation()
        }}
    >
        {busy ? m.reading_cleanup_busy() : m.reading_cleanup_retry()}
    </Button>
    <ul>
        {#each passages as { kind, record } (`${kind}:${record.id}`)}
            <li>
                <blockquote>{record.text}</blockquote>
                <p>{record.noteContent}</p>
            </li>
        {/each}
        {#each records.bookmarks as bookmark (bookmark.id)}
            <li>{bookmark.name}</li>
        {/each}
    </ul>
</section>

<style>
    .cleanup {
        max-width: 48rem;
        margin: 2rem auto;
        padding: 1.5rem;
        border: 1px solid var(--border-color);
        border-radius: var(--radius-lg, 1rem);
        background: var(--bg-secondary);
    }
    p,
    blockquote,
    li {
        white-space: pre-wrap;
        overflow-wrap: anywhere;
    }
</style>
