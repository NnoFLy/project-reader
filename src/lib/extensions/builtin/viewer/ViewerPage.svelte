<script lang="ts">
    import BookViewer from "./components/BookViewer.svelte"
    import { getViewerRelinkHost } from "./viewerRelinkHost"
    import "./styles/pdf-viewer.css"

    const RelinkHost = getViewerRelinkHost()
</script>

<BookViewer />
{#if RelinkHost}
    <RelinkHost />
{/if}
