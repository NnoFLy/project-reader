<script lang="ts">
    import { onMount } from "svelte"
    import { vfsStore } from "$lib/modules/documents"
    import LibraryDashboard from "./components/LibraryDashboard.svelte"

    onMount(() => vfsStore.acquireMetadataEnrichment())
</script>

<LibraryDashboard />
