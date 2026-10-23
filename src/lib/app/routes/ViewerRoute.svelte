<script lang="ts">
    import { getContext, onDestroy } from "svelte"
    import type { Component } from "svelte"
    import { createSubscriber } from "svelte/reactivity"
    import type { Disposable, RegisteredView } from "$lib/extension-api"
    import { APP_HOST_CONTEXT, type AppHostContext } from "../hostContext"
    import ProviderFeedback from "../ProviderFeedback.svelte"

    const hostContext = getContext<AppHostContext>(APP_HOST_CONTEXT)
    const viewerId = "builtin.viewer"
    let ready = $derived(hostContext.ready)
    let host = $derived(ready ? hostContext.application.host : undefined)
    let retrying = $state(false)
    let mounted = true
    let retrySubscription: Disposable | undefined
    onDestroy(() => {
        mounted = false
        retrySubscription?.dispose()
    })

    let subscribe = $derived.by(() => {
        const owner = host
        return createSubscriber((update) => {
            const subscription = owner?.providers.onDidChange(update)
            return () => subscription?.dispose()
        })
    })
    let provider = $derived.by(() => {
        subscribe()
        return host?.providers.get(viewerId)
    })
    let contribution = $derived<RegisteredView | undefined>(
        provider?.state === "active" && !provider.signal.aborted
            ? host?.contributions.listViews().find((view) => view.id === "viewer.reader")
            : undefined,
    )
    let View = $derived(contribution?.component as Component | undefined)

    async function retry() {
        if (retrying || !host) return
        const owner = host
        const order: string[] = []
        const visited: string[] = []
        function collect(id: string) {
            if (visited.includes(id)) return
            visited.push(id)
            for (const dependency of Object.keys(owner.record(id)?.manifest.dependencies ?? {}))
                collect(dependency)
            order.push(id)
        }
        collect(viewerId)
        let cancelled = false
        const subscription = owner.providers.onDidChange((snapshot) => {
            if (
                visited.includes(snapshot.extensionId) &&
                ["disabled", "failed", "disposed"].includes(snapshot.state)
            )
                cancelled = true
        })
        retrySubscription = subscription
        const current = () => mounted && hostContext.ready && host === owner && !cancelled
        retrying = true
        try {
            // Recover only required dependencies, in manifest order, after an explicit action.
            for (const id of order) {
                if (!current()) return
                if (owner.providers.get(id)?.state === "active") continue
                await owner.enable(id)
                if (!current()) return
                await owner.activate(id)
                if (!current() || owner.providers.get(id)?.state !== "active") return
            }
        } catch {
            // Host recovery errors are safe, but feedback never needs exception details.
        } finally {
            subscription.dispose()
            retrySubscription = undefined
            if (mounted) retrying = false
        }
    }
</script>

{#if ready}
    {#if View}
        {#key provider?.generation}
            <View />
        {/key}
    {:else}
        <ProviderFeedback {retrying} {retry} />
    {/if}
{/if}
