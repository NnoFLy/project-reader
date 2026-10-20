<script lang="ts">
    import BookViewer from "./components/BookViewer.svelte"
    import { setViewerRuntimeContext, type ViewerRuntime } from "./viewerRuntime"
    let { runtime }: { runtime: ViewerRuntime } = $props()
    setViewerRuntimeContext(() => runtime)
    import "./styles/pdf-viewer.css"

    const RelinkHost = $derived(runtime.relinkHost)
</script>

<BookViewer />
{#if RelinkHost}
    <RelinkHost />
{/if}
