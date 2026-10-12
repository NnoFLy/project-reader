import { afterEach, describe, expect, it } from "vitest"
import { MemoryStorageBackend, createExtensionStorage } from "$lib/core/storage"
import { createBuiltinHost } from ".."
import { settingsStore } from "./state/settingsStore.svelte"

let host: ReturnType<typeof createBuiltinHost> | undefined

afterEach(async () => {
    await host?.dispose()
    host = undefined
    settingsStore.theme = "system"
})

describe("builtin settings", () => {
    it("registers controls and persists changes in extension storage", async () => {
        const backend = new MemoryStorageBackend()
        host = createBuiltinHost({ storage: backend })
        await host.start()

        const registry = host.contributions.forExtension("builtin.settings").settings
        expect(registry.list().map(({ id }) => id)).toEqual([
            "settings.theme",
            "settings.layout",
            "settings.scale",
            "settings.quality",
            "settings.language",
            "settings.animations",
            "settings.prefer-pdf-title",
        ])

        const commands = host.contributions.forExtension("builtin.settings").commands
        expect(commands.list().map(({ id }) => id)).toEqual([
            "settings.theme",
            "settings.layout",
            "settings.language",
            "settings.zoom.in",
            "settings.zoom.out",
            "settings.quality.in",
            "settings.quality.out",
            "settings.animations.toggle",
            "settings.pdf-title.toggle",
        ])

        await commands.execute("settings.theme", { value: "dark" })
        await new Promise((resolve) => setTimeout(resolve, 0))
        expect(
            await createExtensionStorage(backend, "builtin.settings").get("settings.theme"),
        ).toBe("dark")
    })
})
