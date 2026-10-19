// @vitest-environment jsdom

import { readFileSync } from "node:fs"
import { runInNewContext } from "node:vm"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { SettingsRegistryImpl } from "$lib/core/settings/registry"
import { createExtensionStorage, MemoryStorageBackend } from "$lib/core/storage"

vi.mock("$app/environment", () => ({ browser: true }))

let reduced = true
let reducedMotionTarget: EventTarget
let disposeSettings: (() => void) | undefined

beforeEach(() => {
    vi.resetModules()
    localStorage.clear()
    delete document.documentElement.dataset.motion
    reduced = true
    reducedMotionTarget = new EventTarget()
    vi.stubGlobal(
        "matchMedia",
        vi.fn((query: string) => ({
            matches: query === "(prefers-reduced-motion: reduce)" && reduced,
            addEventListener: reducedMotionTarget.addEventListener.bind(reducedMotionTarget),
            removeEventListener: reducedMotionTarget.removeEventListener.bind(reducedMotionTarget),
        })),
    )
})

afterEach(() => {
    disposeSettings?.()
    disposeSettings = undefined
    localStorage.clear()
    vi.unstubAllGlobals()
})

async function loadSettings() {
    const settings = await import("./settingsStore.svelte")
    const { motionPreferences } = await import("$lib/shared/state/motion.svelte")
    disposeSettings = () => settings.settingsStore.dispose()
    return { ...settings, motionPreferences }
}

describe("animation preference", () => {
    it.each([true, false])("uses reduced motion (%s) only as the default", async (preference) => {
        reduced = preference
        const { DEFAULT_SETTINGS, settingsStore, motionPreferences } = await loadSettings()

        expect(DEFAULT_SETTINGS.animations).toBe(!preference)
        expect(settingsStore.animations).toBe(!preference)
        expect(motionPreferences.enabled).toBe(!preference)
        expect(document.documentElement.dataset.motion).toBe(preference ? "off" : "on")
    })

    it("lets explicit choices control both CSS and JavaScript motion", async () => {
        const { settingsStore, motionPreferences } = await loadSettings()

        settingsStore.animations = true
        expect(settingsStore.animations).toBe(true)
        expect(motionPreferences.enabled).toBe(true)
        expect(document.documentElement.dataset.motion).toBe("on")
        expect(JSON.parse(localStorage.getItem("settings") ?? "{}").animations).toBe(true)

        settingsStore.updateSetting("animations", false)
        expect(motionPreferences.enabled).toBe(false)
        expect(document.documentElement.dataset.motion).toBe("off")
    })

    it.each([true, false])("restores a saved bootstrap choice (%s)", async (animations) => {
        reduced = animations
        localStorage.setItem("settings", JSON.stringify({ animations }))
        const { settingsStore, motionPreferences } = await loadSettings()

        expect(settingsStore.animations).toBe(animations)
        expect(motionPreferences.enabled).toBe(animations)
        expect(document.documentElement.dataset.motion).toBe(animations ? "on" : "off")
    })

    it("restores a namespaced choice over the bootstrap and system defaults", async () => {
        localStorage.setItem("settings", JSON.stringify({ animations: false }))
        const { settingsStore, configureSettings, motionPreferences } = await loadSettings()
        const storage = createExtensionStorage(new MemoryStorageBackend(), "builtin.settings")
        await storage.set("settings.animations", true)
        const registry = new SettingsRegistryImpl("builtin.settings")
        registry.register({ id: "settings.animations", label: "Animations", defaultValue: false })

        configureSettings(registry, storage)
        await vi.waitFor(() => expect(settingsStore.animations).toBe(true))

        expect(motionPreferences.enabled).toBe(true)
        expect(document.documentElement.dataset.motion).toBe("on")
        expect(JSON.parse(localStorage.getItem("settings") ?? "{}").animations).toBe(true)
    })

    it("does not overwrite an explicit choice when the system preference changes", async () => {
        const { settingsStore, motionPreferences } = await loadSettings()
        settingsStore.animations = true

        reduced = false
        reducedMotionTarget.dispatchEvent(Object.assign(new Event("change"), { matches: false }))
        reduced = true
        reducedMotionTarget.dispatchEvent(Object.assign(new Event("change"), { matches: true }))

        expect(settingsStore.animations).toBe(true)
        expect(motionPreferences.enabled).toBe(true)
    })
})

const bootstrap = readFileSync("src/app.html", "utf8").match(/<script>([\s\S]*?)<\/script>/)?.[1]
if (!bootstrap) throw new Error("App bootstrap script not found")

describe("pre-hydration animation preference", () => {
    it.each([
        [true, {}, "off"],
        [false, {}, "on"],
        [true, { animations: true }, "on"],
        [false, { animations: false }, "off"],
        [true, { animations: "true" }, "off"],
    ] as const)(
        "resolves reduced motion %s with saved settings %o",
        (preference, saved, expected) => {
            reduced = preference
            localStorage.setItem("settings", JSON.stringify(saved))

            runInNewContext(bootstrap, { window, document, localStorage })

            expect(document.documentElement.dataset.motion).toBe(expected)
        },
    )

    it("keeps the system default when storage is unavailable", () => {
        runInNewContext(bootstrap, {
            window,
            document,
            localStorage: {
                getItem: () => {
                    throw new Error("Storage blocked")
                },
            },
        })

        expect(document.documentElement.dataset.motion).toBe("off")
    })
})
