<script lang="ts">
    import { ViewerPage, viewerStore } from "$lib/modules/viewer"
    import * as m from "$lib/paraglide/messages"

    const documentTitle = $derived(
        viewerStore.getCurrentBook()?.name
            ? m.viewer_document_title({ name: viewerStore.getCurrentBook()!.name })
            : m.viewer_fallback_title(),
    )
</script>

<svelte:head>
    <title>{documentTitle}</title>
</svelte:head>

<ViewerPage />
