<script lang="ts">
    import RelinkModal from "./RelinkModal.svelte"
    import { relinkRequest, type RelinkRequestState } from "../state/relinkRequest.svelte"
    import { vfsStore, type VFSStore } from "../state/libraryStore.svelte"
    let {
        request = relinkRequest,
        store = vfsStore,
    }: { request?: RelinkRequestState; store?: VFSStore } = $props()
</script>

{#if request.nodeId}
    <RelinkModal {request} {store} />
{/if}
