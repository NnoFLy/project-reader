import type { ExtensionContext } from "$lib/extension-api"
import { ViewerPage } from "$lib/modules/viewer"

export const VIEWER_VIEW_ID = "viewer.reader"

export function activateViewer(context: ExtensionContext): void {
    context.views.registerNative({
        id: VIEWER_VIEW_ID,
        slot: "viewer.toolbar",
        title: "Viewer",
        kind: "native",
        component: ViewerPage,
    })
}
