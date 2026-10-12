<script lang="ts">
    import type { ViewerReflowDocument } from "../viewerDocument"
    import { onMount } from "svelte"

    let { document } = $props<{ document: ViewerReflowDocument }>()
    let sections = $state<readonly { id: string; title?: string; content: string }[]>([])
    let error = $state(false)

    onMount(() => {
        let cancelled = false
        void document
            .getSections()
            .then((loaded: readonly { id: string; title?: string; content: string }[]) => {
                if (!cancelled) sections = loaded
            })
            .catch(() => {
                if (!cancelled) error = true
            })
        return () => {
            cancelled = true
        }
    })
</script>

<div class="reflow-document" aria-live="polite">
    {#if error}
        <p class="reflow-error">Unable to display this document.</p>
    {:else if sections.length === 0}
        <p class="reflow-empty">This document has no readable sections.</p>
    {:else}
        {#each sections as section (section.id)}
            <article>
                {#if section.title}<h2>{section.title}</h2>{/if}
                <p>{section.content}</p>
            </article>
        {/each}
    {/if}
</div>

<style>
    .reflow-document {
        overflow: auto;
        width: min(100%, 52rem);
        height: 100%;
        margin: 0 auto;
        padding: 2rem clamp(1rem, 4vw, 3rem);
        color: var(--text-color);
        background: var(--canvas-bg-color);
        line-height: 1.7;
    }

    article + article {
        margin-top: 2rem;
    }

    h2 {
        margin: 0 0 0.75rem;
    }

    p {
        margin: 0;
        white-space: pre-wrap;
    }

    .reflow-empty,
    .reflow-error {
        color: var(--muted-text-color);
    }
</style>
