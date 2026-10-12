<script lang="ts">
    import { getContext, onMount } from "svelte"
    import type { Component } from "svelte"
    import { updated } from "$app/state"
    import { afterNavigate } from "$app/navigation"
    import { appUpdate } from "$lib/shared/state/appUpdate.svelte"
    import { safeStorageSet } from "$lib/shared/state/safeStorage"
    import { APP_HOST_CONTEXT, type AppHostContext } from "./hostContext"
    import "$lib/shared/styles/variables.css"
    import "$lib/shared/styles/typography.css"
    import "$lib/shared/styles/global.css"

    let { children } = $props()
    const hostContext = getContext<AppHostContext>(APP_HOST_CONTEXT)
    let ready = $derived(hostContext.ready)
    let promptViews = $derived(
        ready ? hostContext.application.host.contributions.listViews("prompt.result") : [],
    )

    afterNavigate(({ to }) => {
        if (!to) return
        const { pathname, search } = to.url
        if (
            pathname === "/" ||
            pathname === "/viewer" ||
            pathname === "/en" ||
            pathname === "/en/viewer"
        ) {
            safeStorageSet("last_visited_url", pathname + search)
        }
    })

    onMount(() => {
        appUpdate.initialize()
        if (updated.current) appUpdate.markAvailable()
    })
</script>

<div id="app-root">
    <div class="app">
        {@render children()}

        {#each promptViews as view (view.id)}
            {@const View = view.component as Component}
            {#if View}
                <View />
            {/if}
        {/each}
    </div>
</div>
