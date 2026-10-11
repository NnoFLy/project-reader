import type { ExtensionContext } from "$lib/extension-api"

export const VIEWER_VIEW_ID = "viewer.reader"

export function activateViewer(context: ExtensionContext): void {
    context.views.register({
        id: VIEWER_VIEW_ID,
        slot: "viewer.toolbar",
        title: "Viewer",
    })
}
