<script lang="ts">
    import { onMount } from "svelte"
    import { vfsStore } from "./state/libraryStore.svelte"
    import LibraryDashboard from "./components/LibraryDashboard.svelte"

    onMount(() => vfsStore.acquireMetadataEnrichment())
</script>

<LibraryDashboard />
