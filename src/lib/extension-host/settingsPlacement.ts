import type { SettingCategory } from "../extension-api"

/** Product policy supplied only by trusted host composition, never contribution metadata. */
export function settingsPlacement(extensionId: string, settingId: string): SettingCategory {
    if (extensionId !== "builtin.settings") return "plugins"
    switch (settingId) {
        case "settings.language":
            return "general"
        case "settings.theme":
        case "settings.ui-font":
        case "settings.ui-custom-font":
        case "settings.ui-font-size":
        case "settings.animations":
            return "appearance"
        case "settings.layout":
        case "settings.scale":
        case "settings.quality":
            return "reading"
        case "settings.prefer-pdf-title":
            return "library"
        default:
            return "plugins"
    }
}
