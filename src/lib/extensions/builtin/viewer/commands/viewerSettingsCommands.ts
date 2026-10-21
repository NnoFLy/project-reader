import { settingsCommands as legacySettingsCommands } from "$lib/core/settings"
import type { SettingsCapability, SettingsCommand } from "$lib/extension-api"
import type { ViewerStore } from "../stores/viewerStore.svelte"
import * as m from "$lib/paraglide/messages"

/** Scoped UI commands retain metadata, but execute through the owning host adapter. */
export function createViewerSettingsCommands(
    store: ViewerStore,
    execute: (id: string, payload?: unknown) => Promise<unknown>,
    settings?: SettingsCapability,
) {
    const commands = settings?.settingsCommands ?? legacySettingsCommands
    const adapt = (id: string, subtitle?: SettingsCommand["subtitle"]): SettingsCommand => ({
        ...commands[id],
        ...(subtitle ? { subtitle } : {}),
        run: async (payload) => {
            await execute(id, payload)
        },
    })
    const scaleSubtitle = () => m.scale_subtitle({ scale: Math.round(store.scale * 100) })
    return {
        layout: adapt("settings.layout", () => `${m.layout()}: ${store.layout}`),
        zoomIn: adapt("settings.zoom.in", scaleSubtitle),
        zoomOut: adapt("settings.zoom.out", scaleSubtitle),
        qualityIn: adapt("settings.quality.in"),
        qualityOut: adapt("settings.quality.out"),
    }
}
