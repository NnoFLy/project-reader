<script lang="ts">
    import * as m from "$lib/paraglide/messages"
    import { vfsStore } from "$lib/modules/documents"
    import { goto } from "$app/navigation"
    import { resolve } from "$app/paths"
    import { localizedPath } from "$lib/modules/settings"

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
        --font-size: clamp(var(--font-size-lg), 3vw, var(--font-size-2xl));
        --gap: clamp(6px, 2vw, 12px);
        margin-bottom: 20px;
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
        font-size: var(--font-size);
        font-weight: normal;
        margin: 0;
        color: var(--text-color);
        letter-spacing: 1px;
        background: transparent;
        border: none;
        padding: 0;
        cursor: pointer;
        font-family: var(--ui-font);
        overflow-wrap: anywhere;
        transition: opacity 0.15s ease;
    }

    .breadcrumb-text-btn:not(.active):hover {
        opacity: 0.7;
        text-decoration: underline;
    }

    .breadcrumb-text-btn.active {
        font-weight: bold;
        cursor: default;
    }

    @media (--phone) {
        .breadcrumbs-nav {
            overflow-x: auto;
            overscroll-behavior-inline: contain;
            scrollbar-width: thin;
        }

        .breadcrumbs-list {
            width: max-content;
            max-width: none;
            flex-wrap: nowrap;
            overflow-wrap: normal;
            white-space: nowrap;
        }
    }
</style>
