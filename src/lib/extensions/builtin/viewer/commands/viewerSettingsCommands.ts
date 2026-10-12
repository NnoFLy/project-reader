import { settingsCommands } from "$lib/core/settings"

export const viewerSettingsCommands = {
    get zoomIn() {
        return settingsCommands["settings.zoom.in"]
    },
    get zoomOut() {
        return settingsCommands["settings.zoom.out"]
    },
    get qualityIn() {
        return settingsCommands["settings.quality.in"]
    },
    get qualityOut() {
        return settingsCommands["settings.quality.out"]
    },
}
