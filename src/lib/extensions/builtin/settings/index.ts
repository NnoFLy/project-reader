import type { ExtensionContext } from "$lib/extension-api"

export const SETTINGS_VIEW_ID = "settings.panel"

export function activateSettings(context: ExtensionContext): void {
    context.views.register({
        id: SETTINGS_VIEW_ID,
        slot: "workbench.sidebar",
        title: "Settings",
    })
    context.settings.register({
        id: "settings.theme",
        label: "Theme",
        defaultValue: "system",
        validate: (value): value is "light" | "dark" | "system" =>
            value === "light" || value === "dark" || value === "system",
    })
    context.settings.register({
        id: "settings.layout",
        label: "Layout",
        defaultValue: "scroll",
        validate: (value): value is "single" | "split" | "scroll" =>
            value === "single" || value === "split" || value === "scroll",
    })
}
