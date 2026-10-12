<script lang="ts">
    import BookItemIcon from "$lib/shared/icons/BookItemIcon.svelte"
    import { usePreviewUrl } from "$lib/modules/documents"
    import * as m from "$lib/paraglide/messages"

    let { bookId }: { bookId: string } = $props()
    const preview = usePreviewUrl(() => bookId)
    const previewUrl = $derived(preview.url)
</script>

{#if previewUrl}
    <img src={previewUrl} alt={m.cover_preview_alt()} />
{:else}
    <BookItemIcon />
{/if}

<style>
    img {
        width: 100%;
        height: 100%;
        object-fit: cover;
    }
</style>
