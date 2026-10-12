import { defineCommands } from "$lib/modules/commands"
import * as m from "$lib/paraglide/messages"

export function createViewerFitWidthCommand(fitToWidth: () => void) {
    return defineCommands({
        "viewer.zoom.fit-width": {
            id: "viewer.zoom.fit-width",
            keymap: "=",
            label: () => m.keymap_zoom_to_fit(),
            englishLabel: () => m.keymap_zoom_to_fit({}, { locale: "en" }),
            category: "settings",
            run: fitToWidth,
        },
    })["viewer.zoom.fit-width"]!
}
