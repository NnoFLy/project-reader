<script lang="ts">
    import * as m from "$lib/paraglide/messages"
    import { vfsStore } from "../state/libraryStore.svelte"
    import { goto } from "$app/navigation"
    import { resolve } from "$app/paths"
    import { localizedPath } from "../state/librarySettings"

    interface Props {
        breadcrumbs: {
            name: string
            id: string | null
        }[]
    }

    let { breadcrumbs }: Props = $props()
</script>

{#if breadcrumbs.length > 1}
    <nav aria-label={m.breadcrumb()} class="breadcrumbs-nav">
        <ol class="breadcrumbs-list">
            {#each breadcrumbs as segment, idx (segment.id || "root")}
                <li class="breadcrumb-item">
                    <button
                        type="button"
                        class="breadcrumb-text-btn"
                        class:active={idx === breadcrumbs.length - 1}
                        onclick={() => {
                            vfsStore.clearForwardHistory()
                            const base = localizedPath("/")
                            goto(
                                resolve(
                                    (segment.id
                                        ? `${base}?folder=${encodeURIComponent(vfsStore.getFolderPath(segment.id))}`
                                        : base) as any,
                                ),
                            )
                        }}
                        disabled={idx === breadcrumbs.length - 1}
                        aria-current={idx === breadcrumbs.length - 1 ? "page" : undefined}
                    >
                        {segment.name}
                    </button>
                    {#if idx < breadcrumbs.length - 1}
                        <span class="separator" aria-hidden="true">/</span>
                    {/if}
                </li>
            {/each}
        </ol>
    </nav>
{/if}

<style>
    .breadcrumbs-nav {
        --font-size: clamp(var(--font-size-sm), 2vw, var(--font-size-base));
        --gap: clamp(6px, 1.5vw, 10px);
        margin-block-end: var(--space-3);
    }

    .breadcrumbs-list {
        display: flex;
        flex-wrap: wrap;
        overflow-wrap: anywhere;
        list-style: none;
        margin: 0;
        padding: 0;
        gap: var(--gap);
    }

    .breadcrumb-item {
        min-inline-size: 0;
        display: flex;
        align-items: center;
        gap: var(--gap);
    }

    .separator {
        color: var(--text-color);
        font-size: var(--font-size);
        font-weight: bold;
        user-select: none;
    }

    .breadcrumb-text-btn {
        min-inline-size: 0;
        font-size: var(--font-size);
        font-weight: normal;
        margin: 0;
        color: var(--text-color);
        letter-spacing: 0.01em;
        background: transparent;
        border: none;
        padding: 0;
        cursor: pointer;
        font-family: var(--ui-font);
        overflow-wrap: anywhere;
        transition: opacity 0.12s ease;

        &:not(.active):hover {
            opacity: 0.7;
            text-decoration: underline;
        }

        &.active {
            font-weight: 600;
            cursor: default;
        }
    }

    @media (--phone) {
        .breadcrumbs-nav {
            overflow-x: auto;
            overscroll-behavior-inline: contain;
            scrollbar-width: thin;
        }

        .breadcrumbs-list {
            inline-size: max-content;
            max-inline-size: none;
            flex-wrap: nowrap;
            overflow-wrap: normal;
            white-space: nowrap;
        }

        .breadcrumb-item {
            flex-shrink: 0;
        }
    }
</style>
