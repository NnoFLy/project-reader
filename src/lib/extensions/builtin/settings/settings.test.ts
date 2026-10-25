import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { MemoryStorageBackend, createExtensionStorage } from "$lib/core/storage"
import * as safeStorage from "$lib/shared/state/safeStorage"
import { createBuiltinHost } from ".."
import { KeyboardHandler, normalizeKeybinding, resolveHostKeybindings } from "$lib/core/commands"
import { DEFAULT_SETTINGS, settingsStore } from "./state/settingsStore.svelte"
import * as localeRuntime from "$lib/paraglide/runtime"

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
    it.each([
        { tagName: "BUTTON" },
        { tagName: "INPUT" },
        { tagName: "TEXTAREA" },
        { tagName: "SELECT" },
        { tagName: "DIV", isContentEditable: true },
    ])("dispatches Ctrl+, to settings.open from $tagName", async (target) => {
        host = createBuiltinHost({ storage: new MemoryStorageBackend() })
        await host.start()
        const open = vi.fn()
        const subscription = host.settingsCapability!.onDidRequestOpen(open)
        try {
            const event = {
                key: ",",
                code: "Comma",
                ctrlKey: true,
                altKey: false,
                shiftKey: false,
                metaKey: false,
                target,
            } as unknown as KeyboardEvent
            const candidates = KeyboardHandler.candidates(event)
            const bindings = host.commands
                .listKeybindings()
                .filter(({ keybinding }) => candidates.has(normalizeKeybinding(keybinding)))
            const eligible = await resolveHostKeybindings(bindings, event)
            expect(eligible).toHaveLength(1)
            expect(eligible[0]).toMatchObject({
                commandId: "settings.open",
                allowInInputs: true,
            })
            await host.commands.execute(eligible[0].commandId, undefined, event)
            expect(open).toHaveBeenCalledOnce()
        } finally {
            subscription.dispose()
        }
    })

    it("describes all seven preferences as localized editable application preferences and new-session defaults", async () => {
        host = createBuiltinHost({ storage: new MemoryStorageBackend() })
        await host.start()
        const locale = vi.spyOn(localeRuntime, "getLocale").mockReturnValue("en")
        const entries = host.settings.list()
        expect(
            entries.map(({ id, defaultValue, category, editorUnavailableReason }) => [
                id,
                defaultValue,
                category,
                editorUnavailableReason,
            ]),
        ).toEqual([
            ["settings.theme", "system", "appearance", undefined],
            ["settings.layout", "scroll", "reading", undefined],
            ["settings.scale", 1.5, "reading", undefined],
            ["settings.quality", 3, "reading", undefined],
            ["settings.language", "ru", "general", undefined],
            ["settings.animations", DEFAULT_SETTINGS.animations, "appearance", undefined],
            ["settings.prefer-pdf-title", true, "library", undefined],
        ])
        const text = (value: string | (() => string) | undefined) =>
            typeof value === "function" ? value() : value
        expect(text(host.settings.get("settings.layout")?.label)).toBe("Default page layout")
        expect(text(host.settings.get("settings.scale")?.label)).toBe("Default zoom")
        for (const entry of entries) {
            expect(text(entry.description)).toBeTruthy()
            const english = text(entry.label)
            locale.mockReturnValue("ru")
            expect(text(entry.label)).not.toBe(english)
            locale.mockReturnValue("en")
        }
        expect(text(host.settings.get("settings.layout")?.description)).toContain(
            "new Reading sessions",
        )
        expect(text(host.settings.get("settings.scale")?.description)).toContain(
            "new Reading sessions",
        )
        expect(text(host.settings.get("settings.quality")?.description)).toContain(
            "all Reading sessions",
        )
        await expect(host.settings.setValue("settings.scale", 1.2345)).resolves.toBeUndefined()
        for (const [id, value] of [
            ["settings.theme", "sepia"],
            ["settings.layout", "book"],
            ["settings.scale", 0.1],
            ["settings.scale", Infinity],
            ["settings.quality", 2.5],
            ["settings.quality", 6],
            ["settings.language", "de"],
            ["settings.animations", "false"],
            ["settings.prefer-pdf-title", 0],
        ] as const) {
            await expect(host.settings.setValue(id, value)).rejects.toThrow()
        }
    })

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
            "settings.open",
        ])

        await commands.execute("settings.theme", { value: "dark" })
        await new Promise((resolve) => setTimeout(resolve, 0))
        expect(
            await createExtensionStorage(backend, "builtin.settings").get("settings.theme"),
        ).toBe("dark")
    })
})
