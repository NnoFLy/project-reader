<script lang="ts">
    import { getContext } from "svelte"
    import type { Component } from "svelte"
    import type { RegisteredView } from "$lib/extension-api"
    import { APP_HOST_CONTEXT, type AppHostContext } from "../hostContext"

    const hostContext = getContext<AppHostContext>(APP_HOST_CONTEXT)
    let ready = $derived(hostContext.ready)
    let contribution = $derived<RegisteredView | undefined>(
        ready
            ? hostContext.application.host.contributions
                  .listViews()
                  .find((view) => view.id === "library.page")
            : undefined,
    )
    let View = $derived(contribution?.component as Component | undefined)
</script>

{#if View}
    <View />
{/if}
