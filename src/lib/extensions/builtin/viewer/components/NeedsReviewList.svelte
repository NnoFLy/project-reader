<script lang="ts">
    import { onMount } from "svelte"
    import * as m from "$lib/paraglide/messages"
    import { getViewerRuntimeContext } from "../viewerRuntime"
    import type { ReadingReviewItem } from "../readingWorkspace"
    const { store } = getViewerRuntimeContext()()
    const { documentId } = $props<{ documentId: string }>()
    let revision = $state(0)
    let feedback = $state("")
    let busy = $state(false)
    let retryId = $state<string | null>(null)
    const items = $derived.by(() => {
        void revision
        return store.workspace.needsReview(documentId)
    })
    onMount(() => store.workspace.subscribeAnnotations(() => revision++))

    function text(item: ReadingReviewItem): string {
        const record = item.record
        return item.kind === "bookmark"
            ? `${record.pageNumber}: ${item.record.name}`
            : `${record.pageNumber}: ${item.record.text}\n${item.record.noteContent}`
    }
    async function copy(item: ReadingReviewItem) {
        try {
            await navigator.clipboard.writeText(text(item))
            feedback = m.review_copied()
        } catch {
            feedback = m.review_copy_failed()
        }
    }
    async function discard(item: ReadingReviewItem) {
        busy = true
        const id = documentId
        const result = await store.workspace.discardReviewItem(id, item.kind, item.record.id)
        if (id === documentId) {
            retryId = result.ok ? null : id
            feedback = result.ok ? "" : m.review_discard_failed()
        }
        busy = false
    }
    async function retry() {
        const id = retryId
        if (!id) return
        busy = true
        const result = await store.workspace.persistDrafts(id)
        if (id === documentId) {
            feedback = result.ok ? "" : m.review_discard_failed()
            retryId = result.ok ? null : id
        }
        busy = false
    }
</script>

{#if items.length}
    <section aria-label={m.review_title()}>
        <h3>{m.review_title()}</h3>
        <p>{m.review_description()}</p>
        <ul>
            {#each items as item (`${item.kind}-${item.record.id}`)}
                <li>
                    <h4>
                        {item.kind === "note"
                            ? m.review_note()
                            : item.kind === "draft"
                              ? m.review_draft()
                              : m.review_bookmark()} · {m.page()}
                        {item.record.pageNumber}
                    </h4>
                    {#if item.kind === "bookmark"}
                        <p class="preserved">{item.record.name}</p>
                    {:else}
                        <blockquote class="preserved">{item.record.text}</blockquote>
                        <p class="preserved">{item.record.noteContent}</p>
                    {/if}
                    <div class="actions">
                        <button type="button" onclick={() => copy(item)}>{m.review_copy()}</button>
                        <button type="button" disabled={busy} onclick={() => discard(item)}
                            >{m.discard()}</button
                        >
                    </div>
                </li>
            {/each}
        </ul>
    </section>
{/if}
<p class="feedback" role="status">{feedback}</p>
{#if retryId === documentId}
    <button type="button" disabled={busy} onclick={retry}>{m.viewer_provider_retry()}</button>
{/if}

<style>
    section {
        padding: 1rem;
        color: var(--text-color);
        border-block-end: 1px solid var(--border-color);
    }
    h3,
    h4 {
        margin: 0 0 0.5rem;
    }
    p {
        font-size: var(--font-size-sm);
    }
    ul {
        padding: 0;
        margin: 0;
        list-style: none;
    }
    li {
        margin-block-start: 1rem;
        padding: 0.75rem;
        border: 1px solid var(--border-color);
        border-radius: 0.75rem;
    }
    .preserved {
        white-space: pre-wrap;
        overflow-wrap: anywhere;
        user-select: text;
        margin: 0.5rem 0;
    }
    .actions {
        display: flex;
        flex-wrap: wrap;
        gap: 0.5rem;
    }
    button {
        color: var(--text-color);
        background: var(--bg-color);
        border: 1px solid var(--border-color);
        border-radius: 0.4rem;
        padding: 0.5rem;
        cursor: pointer;
    }
    button:focus-visible {
        outline: 2px solid var(--accent-color);
        outline-offset: 2px;
    }
    .feedback {
        margin: 0;
        padding-inline: 1rem;
    }
</style>
