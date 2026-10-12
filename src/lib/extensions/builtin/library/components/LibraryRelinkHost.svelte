<script lang="ts">
    import RelinkModal from "./RelinkModal.svelte"
    import { relinkRequest } from "../state/relinkRequest.svelte"
</script>

{#if relinkRequest.nodeId}
    <RelinkModal />
{/if}
