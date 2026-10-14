import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { MemoryStorageBackend, createExtensionStorage } from "$lib/core/storage"
import * as safeStorage from "$lib/shared/state/safeStorage"
import { createBuiltinHost } from ".."
import { settingsStore } from "./state/settingsStore.svelte"

let host: ReturnType<typeof createBuiltinHost> | undefined
const legacyStorage = new Map<string, string>()

beforeEach(() => {
    vi.stubGlobal("localStorage", {
        getItem: (key: string) => legacyStorage.get(key) ?? null,
        setItem: (key: string, value: string) => legacyStorage.set(key, value),
        removeItem: (key: string) => legacyStorage.delete(key),
    })
    legacyStorage.clear()
    vi.spyOn(safeStorage, "safeStorageGet").mockImplementation(
        (key) => legacyStorage.get(key) ?? null,
    )
})

afterEach(async () => {
    await host?.dispose()
    host = undefined
    settingsStore.theme = "system"
    legacyStorage.clear()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
})

describe("builtin settings", () => {
    it("migrates sanitized legacy values without replacing namespaced values", async () => {
        legacyStorage.set(
            "settings",
            JSON.stringify({
                theme: "light",
                layout: "single",
                scale: 99,
                quality: 4,
                language: "en",
                animations: false,
                preferPdfTitle: false,
            }),
        )
        const backend = new MemoryStorageBackend()
        const namespaced = createExtensionStorage(backend, "builtin.settings")
        await namespaced.set("settings.theme", "dark")
        host = createBuiltinHost({ storage: backend })
        await host.start()
        await vi.waitFor(() => expect(settingsStore.quality).toBe(4))

        expect(settingsStore.theme).toBe("dark")
        expect(settingsStore.scale).toBe(1.5)
        expect(settingsStore.quality).toBe(4)
        expect(settingsStore.language).toBe("en")
        expect(settingsStore.animations).toBe(false)
        expect(settingsStore.preferPdfTitle).toBe(false)
        expect(await namespaced.get("settings.layout")).toBe("single")
        expect(await namespaced.get("settings.scale")).toBeUndefined()
        expect(await namespaced.get("settings.theme")).toBe("dark")
    })

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
