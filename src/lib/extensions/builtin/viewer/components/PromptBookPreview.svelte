<script lang="ts">
    import BookItemIcon from "$lib/shared/icons/BookItemIcon.svelte"
    import {
        useViewerPreviewUrl as usePreviewUrl,
        type ViewerPreviewCapability,
    } from "../stores/viewerPreview.svelte"
    import * as m from "$lib/paraglide/messages"

    let { bookId, preview }: { bookId: string; preview?: ViewerPreviewCapability } = $props()
    const image = usePreviewUrl(
        () => bookId,
        () => preview,
    )
    const previewUrl = $derived(image.url)
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
