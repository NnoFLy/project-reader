<script lang="ts">
    import type { ContextualStatus, ContextualStatusService } from "$lib/extension-api"
    import { page } from "$app/state"
    import * as m from "$lib/paraglide/messages"
    import { vfsStore } from "./state/libraryStore.svelte"

    const SOURCE = "builtin.library.contextual-status"
    const PRIORITY_SELECTION = 3
    const PRIORITY_IMPORT = 1

    let { contextualStatus }: { contextualStatus: ContextualStatusService<ContextualStatus> } =
        $props()

    $effect(() => {
        const isViewerPage = page.url.pathname.includes("/viewer")
        const selectedCount = vfsStore.selectedIds.size
        const importCount = vfsStore.activeImportCount
        const status =
            !isViewerPage && selectedCount > 0
                ? {
                      line1: `${selectedCount}`,
                      line2: m.selected_label(),
                      priority: PRIORITY_SELECTION,
                  }
                : !isViewerPage && importCount > 0
                  ? {
                        line1: `${importCount}`,
                        line2: m.importing_book().replace("...", "").trim().toUpperCase(),
                        priority: PRIORITY_IMPORT,
                    }
                  : null

        const publication = contextualStatus.publish(SOURCE, status)
        return () => publication.dispose()
    })
</script>
