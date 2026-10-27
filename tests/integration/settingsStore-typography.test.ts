// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest"
import { createBuiltinHost } from "$lib/extensions/builtin"
import { MemoryStorageBackend, createExtensionStorage } from "$lib/core/storage"
import {
    DEFAULT_SETTINGS,
    settingsStore,
} from "$lib/extensions/builtin/settings/state/settingsStore.svelte"

vi.mock("$app/environment", () => ({ browser: true, dev: true, building: false }))
vi.hoisted(() => {
    window.matchMedia = (() => ({
        matches: false,
        addEventListener() {},
        removeEventListener() {},
    })) as unknown as typeof window.matchMedia
})

let host: ReturnType<typeof createBuiltinHost> | undefined

afterEach(async () => {
    await host?.dispose()
    host = undefined
    localStorage.clear()
    document.documentElement.removeAttribute("style")
    vi.restoreAllMocks()
})

it("applies acknowledged typography tokens without changing mono, root size or PDF zoom", async () => {
    const storage = new MemoryStorageBackend()
    host = createBuiltinHost({ storage })
    await host.start()
    const style = document.documentElement.style
    style.setProperty("--ui-mono-font", '"IBM Plex Mono", monospace')
    style.fontSize = "18px"
    await host.settings.setValue("settings.ui-font", "source-serif")
    expect(style.getPropertyValue("--ui-font")).toBe('"Source Serif 4", Georgia, serif')
    expect(style.getPropertyValue("--display-font")).toBe(style.getPropertyValue("--ui-font"))
    await host.settings.setValue("settings.ui-font", "system")
    expect(style.getPropertyValue("--ui-font")).toContain("system-ui")
    await host.settings.setValue("settings.ui-font", "plex-mono")
    expect(style.getPropertyValue("--ui-font")).toContain('"IBM Plex Mono"')
    await host.settings.setValue("settings.ui-custom-font", "Missing Installed Font")
    await host.settings.setValue("settings.ui-font", "custom")
    expect(style.getPropertyValue("--ui-font")).toBe(
        '"Missing Installed Font", "IBM Plex Sans", sans-serif',
    )
    await host.settings.setValue("settings.ui-font-size", 150)
    expect(style.getPropertyValue("--ui-font-scale")).toBe("1.5")
    expect(style.getPropertyValue("--ui-mono-font")).toBe('"IBM Plex Mono", monospace')
    expect(style.fontSize).toBe("18px")
    expect(settingsStore.scale).toBe(DEFAULT_SETTINGS.scale)

    const set = storage.set.bind(storage)
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
        release = resolve
    })
    vi.spyOn(storage, "set").mockImplementation(async (key, value) => {
        if (key.endsWith(":settings.ui-font-size")) await gate
        await set(key, value)
    })
    const writing = settingsStore.updateSetting("uiFontSize", 85)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(style.getPropertyValue("--ui-font-scale")).toBe("1.5")
    release()
    await writing
    expect(style.getPropertyValue("--ui-font-scale")).toBe("0.85")

    vi.spyOn(storage, "set").mockRejectedValue(new Error("disk full"))
    await expect(settingsStore.updateSetting("uiFontSize", 125)).rejects.toThrow()
    expect(settingsStore.writeErrors.uiFontSize).toBeTruthy()
    expect(style.getPropertyValue("--ui-font-scale")).toBe("0.85")
    vi.mocked(storage.set).mockImplementation(set)
    await settingsStore.updateSetting("uiFontSize", 125)
    expect(settingsStore.writeErrors.uiFontSize).toBeUndefined()
    expect(style.getPropertyValue("--ui-font-scale")).toBe("1.25")
    await host.settings.resetValue("settings.ui-custom-font")
    expect(style.getPropertyValue("--ui-font")).toBe('"IBM Plex Sans", sans-serif')
    await host.settings.resetValue("settings.ui-font-size")
    expect(style.getPropertyValue("--ui-font-scale")).toBe("1")
})

it("rejects unsafe stored typography and restores valid saved tokens", async () => {
    const storage = new MemoryStorageBackend()
    const namespace = createExtensionStorage(storage, "builtin.settings")
    await namespace.set("settings.ui-font", "custom")
    await namespace.set("settings.ui-custom-font", 'Arial"; background: url(https://example.com)')
    await namespace.set("settings.ui-font-size", 1000)
    host = createBuiltinHost({ storage })
    await host.start()
    expect(settingsStore.uiCustomFont).toBe("")
    expect(settingsStore.uiFontSize).toBe(100)
    expect(document.documentElement.style.getPropertyValue("--ui-font")).toBe(
        '"IBM Plex Sans", sans-serif',
    )
    await host.settings.setValue("settings.ui-custom-font", "Arial")
    await host.settings.setValue("settings.ui-font-size", 120)
    await host.dispose()
    host = createBuiltinHost({ storage })
    await host.start()
    expect(document.documentElement.style.getPropertyValue("--ui-font")).toBe(
        '"Arial", "IBM Plex Sans", sans-serif',
    )
    expect(document.documentElement.style.getPropertyValue("--ui-font-scale")).toBe("1.2")
})
