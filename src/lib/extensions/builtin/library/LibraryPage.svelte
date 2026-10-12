<script lang="ts">
    import { getContext, onMount } from "svelte"
    import { promptStore } from "$lib/modules/prompt"
    import { configureLibraryHostBridge } from "./state/libraryHostBridge"
    import { vfsStore } from "./state/libraryStore.svelte"
    import LibraryDashboard from "./components/LibraryDashboard.svelte"

    const hostServices = getContext<{
        executeCommand(commandId: string, payload?: unknown): Promise<unknown>
    }>("app-host-services")
    configureLibraryHostBridge({
        prompt: promptStore,
        execute: (commandId, payload) => hostServices.executeCommand(commandId, payload),
    })

    onMount(() => {
        void vfsStore.acquireMetadataEnrichment()
        return () => configureLibraryHostBridge(undefined)
    })
</script>

<LibraryDashboard />
