<script lang="ts">
    import type { ContextualStatus, ContextualStatusService } from "$lib/extension-api"
    import { page } from "$app/state"
    import * as m from "$lib/paraglide/messages"
    import { searchStore } from "./stores/searchStore.svelte"

    const SOURCE = "builtin.viewer.contextual-status"
    const PRIORITY_SEARCH = 2

    let { contextualStatus }: { contextualStatus: ContextualStatusService<ContextualStatus> } =
        $props()

    $effect(() => {
        const isViewerPage = page.url.pathname.includes("/viewer")
        const matchCount = searchStore.matches.length
        const status =
            isViewerPage && searchStore.isActive && matchCount > 0
                ? {
                      line1: `${searchStore.currentMatchIndex + 1} / ${matchCount}`,
                      line2: m.matched_label(),
                      priority: PRIORITY_SEARCH,
                  }
                : null

        const publication = contextualStatus.publish(SOURCE, status)
        return () => publication.dispose()
    })
</script>
