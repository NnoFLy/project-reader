// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest"
import { Blob as NodeBlob } from "node:buffer"
import { URL as NodeURL } from "node:url"
import type {
    AppExtension,
    DocumentAdapter,
    ExtensionStorage,
    SettingsCapability,
    SettingsRegistry,
} from "$lib/extension-api"
import { activateSettings, settingsStore } from "$lib/extensions/builtin/settings"
import { motionPreferences } from "$lib/shared/state/motion.svelte"
import * as localeRuntime from "$lib/paraglide/runtime"
import { ExtensionHost } from "$lib/extension-host"
import { BUILTIN_MANIFESTS, createBuiltinHost } from "$lib/extensions/builtin"
import { createExtensionStorage, MemoryStorageBackend } from "$lib/core/storage"
import { viewerStore } from "$lib/extensions/builtin/viewer"

vi.hoisted(() => {
    window.matchMedia = (() => ({
        matches: false,
        addEventListener() {},
        removeEventListener() {},
    })) as unknown as typeof window.matchMedia
})

const integrationExtension = (id: string, activate: AppExtension["activate"]): AppExtension => ({
    manifest: {
        id,
        name: id,
        version: "1.0.0",
        engine: "*",
        entry: id,
        activationEvents: [{ type: "startup" }],
        permissions: ["commands", "documents", "settings", "storage", "views"],
    },
    activate,
})

const integrationDocumentAdapter = {
    id: "builtin.first.fake",
    extensions: ["fake"],
    mimeTypes: ["application/x-fake-document"],
    probe: async (_source, signal) => {
        signal?.throwIfAborted()
        return { supported: true, confidence: 1, format: "fake" }
    },
    open: async (source, signal) => {
        signal?.throwIfAborted()
        return {
            kind: "paged" as const,
            metadata: { title: source.name, author: null, pageCount: 1 },
            capabilities: new Set(),
            pageCount: 1,
            getPage: async (pageNumber: number) => ({
                pageNumber,
                width: 600,
                height: 800,
            }),
            renderPage: async (pageNumber: number, options = {}) => {
                options.signal?.throwIfAborted()
                const scale = options.scale ?? 1
                return {
                    pageNumber,
                    url: `fake://${encodeURIComponent(source.id)}/${pageNumber}`,
                    width: 600 * scale,
                    height: 800 * scale,
                    mimeType: "image/fake",
                }
            },
            close: async () => source.close?.(),
        }
    },
} satisfies DocumentAdapter

describe("built-in extension host integration", () => {
    it("imports legacy language authority without requesting bootstrap navigation", async () => {
        localStorage.setItem("settings", JSON.stringify({ language: "ru" }))
        localeRuntime.setLocale("en", { reload: false })
        const href = "https://example.test/en?keep=1#position"
        const navigate = vi.fn()
        const location = {
            get href() {
                return href
            },
            set href(value: string) {
                navigate(value)
            },
            origin: "https://example.test",
            pathname: "/en",
            search: "?keep=1",
            hash: "#position",
        }
        vi.stubGlobal("window", { location, matchMedia: window.matchMedia })
        const setLocale = vi.spyOn(localeRuntime, "setLocale")
        const storage = new MemoryStorageBackend()
        const host = createBuiltinHost({ storage })
        try {
            await host.start()
            expect(await host.settings.getValue("settings.language")).toBe("ru")
            expect(host.settingsCapability!.settingsStore.language).toBe("ru")
            expect(setLocale).toHaveBeenCalledWith("ru", { reload: false })
            // URL-first locale detection stays English until a later document navigation.
            expect(localeRuntime.getLocale()).toBe("en")
            expect(document.cookie).toContain("PARAGLIDE_LOCALE=ru")
            expect(document.documentElement.lang).toBe("ru")
            expect(location.href).toBe(href)
            expect(navigate).not.toHaveBeenCalled()
        } finally {
            await host.dispose()
            vi.unstubAllGlobals()
            vi.restoreAllMocks()
            localStorage.clear()
        }
    })

    it.each([undefined, "ru", "en"] as const)(
        "preserves interactive %s language intent without bootstrap navigation during a held import",
        async (language) => {
            localStorage.setItem("settings", JSON.stringify({ language: "ru" }))
            const location = {
                href: "https://example.test/en?keep=1#position",
                origin: "https://example.test",
                pathname: "/en",
                search: "?keep=1",
                hash: "#position",
            }
            vi.stubGlobal("window", { location, matchMedia: window.matchMedia })
            const storage = new MemoryStorageBackend()
            const set = storage.set.bind(storage)
            let release!: () => void
            const held = new Promise<void>((resolve) => {
                release = resolve
            })
            let importing = false
            storage.set = async (key, value) => {
                if (key.endsWith(":settings.language") && !importing) {
                    importing = true
                    await held
                }
                await set(key, value)
            }
            const host = createBuiltinHost({ storage })
            try {
                await host.start()
                expect(importing).toBe(true)
                const present = vi.fn((navigate: (() => void) | undefined) => navigate?.())
                host.settingsCapability!.onDidRequestNavigation(present)
                const command =
                    language === undefined
                        ? undefined
                        : host.commands.execute("settings.language", { value: language })
                release()
                await command
                const saved = await host.settings.getValue("settings.language")
                expect(present).toHaveBeenCalledTimes(language === undefined ? 0 : 1)
                if (language === undefined) {
                    expect(location.href).toBe("https://example.test/en?keep=1#position")
                } else if (language === "en") {
                    expect(present).toHaveBeenLastCalledWith(undefined)
                    expect(location.href).toBe("https://example.test/en?keep=1#position")
                } else {
                    expect(location.href).toBe("/?keep=1#position")
                }
                const expected = language ?? "ru"
                expect(saved).toBe(expected)
                expect(host.settingsCapability!.settingsStore.language).toBe(expected)
                expect(document.documentElement.lang).toBe(expected)
                expect(document.cookie).toContain(`PARAGLIDE_LOCALE=${expected}`)
            } finally {
                release()
                await host.dispose()
                vi.unstubAllGlobals()
                localStorage.clear()
            }
        },
    )

    it.each([
        ["ru", false],
        ["ru", true],
        ["en", false],
    ] as const)(
        "preserves an external %s language ACK before stale bootstrap import (import read fails: %s)",
        async (language, failImport) => {
            localStorage.setItem("settings", JSON.stringify({ language: "ru" }))
            const location = {
                href: "https://example.test/en",
                origin: "https://example.test",
                pathname: "/en",
                search: "",
                hash: "",
            }
            vi.stubGlobal("window", { location, matchMedia: window.matchMedia })
            const storage = new MemoryStorageBackend()
            const get = storage.get.bind(storage)
            const set = storage.set.bind(storage)
            let releaseRead!: () => void
            const readHeld = new Promise<void>((resolve) => {
                releaseRead = resolve
            })
            let reads = 0
            let external!: Promise<void>
            storage.get = async (key) => {
                const value = await get(key)
                if (key.endsWith(":settings.language")) {
                    reads++
                    if (reads === 1) await readHeld
                    // Admit the catalog write behind this registry read, ahead of import.
                    if (reads === 2)
                        external = host.settings.setValue("settings.language", language)
                    if (reads === 3 && failImport) throw new Error("import read unavailable")
                }
                return value
            }
            let releaseExternal!: () => void
            const externalHeld = new Promise<void>((resolve) => {
                releaseExternal = resolve
            })
            let writes = 0
            storage.set = async (key, value) => {
                if (key.endsWith(":settings.language")) {
                    writes++
                    if (writes === 1) await externalHeld
                }
                await set(key, value)
            }
            const host = createBuiltinHost({ storage })
            try {
                await host.start()
                expect(reads).toBe(1)
                const present = vi.fn<(navigate: (() => void) | undefined) => void>()
                host.settingsCapability!.onDidRequestNavigation(present)
                releaseRead()
                await vi.waitFor(() => expect(writes).toBe(1))
                // The import is admitted behind the held catalog write before either ACK.
                await new Promise((resolve) => setTimeout(resolve, 0))
                const setLocale = vi.spyOn(localeRuntime, "setLocale")
                releaseExternal()
                await external
                expect(await host.settings.getValue("settings.language")).toBe(language)
                expect(writes).toBe(1)
                expect(present).toHaveBeenCalledTimes(1)
                present.mock.calls[0][0]?.()
                expect(location.href).toBe(language === "ru" ? "/" : "https://example.test/en")
                if (language === "en") expect(present).toHaveBeenLastCalledWith(undefined)
                expect(setLocale).toHaveBeenCalledTimes(1)
                expect(host.settingsCapability!.settingsStore.language).toBe(language)
                expect(document.documentElement.lang).toBe(language)
                expect(document.cookie).toContain(`PARAGLIDE_LOCALE=${language}`)
                expect(await host.settings.getValue("settings.language")).toBe(language)
            } finally {
                releaseRead()
                releaseExternal()
                await host.dispose()
                vi.unstubAllGlobals()
                vi.restoreAllMocks()
                localStorage.clear()
            }
        },
    )

    it("does not apply a failed bootstrap language import or overwrite a successful command with a stale initial read", async () => {
        localStorage.setItem("settings", JSON.stringify({ language: "ru" }))
        const location = {
            href: "https://example.test/en",
            origin: "https://example.test",
            pathname: "/en",
            search: "",
            hash: "",
        }
        vi.stubGlobal("window", { location, matchMedia: window.matchMedia })
        localeRuntime.setLocale("en", { reload: false })
        document.cookie = "PARAGLIDE_LOCALE=en; path=/"
        const storage = new MemoryStorageBackend()
        const set = storage.set.bind(storage)
        storage.set = async (key, value) => {
            if (key.endsWith(":settings.language")) throw new Error("import unavailable")
            await set(key, value)
        }
        const setLocale = vi.spyOn(localeRuntime, "setLocale")
        const host = createBuiltinHost({ storage })
        try {
            await host.start()
            expect(host.settingsCapability!.settingsStore.loadErrors.language).toBeTruthy()
            expect(setLocale).not.toHaveBeenCalled()
            expect(localeRuntime.getLocale()).toBe("en")
            expect(document.cookie).toContain("PARAGLIDE_LOCALE=en")
            expect(
                await createExtensionStorage(storage, "builtin.settings").get("settings.language"),
            ).toBeUndefined()
        } finally {
            await host.dispose()
            vi.restoreAllMocks()
            localStorage.clear()
        }

        localStorage.setItem("settings", JSON.stringify({ language: "ru" }))
        storage.set = set
        const get = storage.get.bind(storage)
        let release!: () => void
        const held = new Promise<void>((resolve) => {
            release = resolve
        })
        let reading = false
        storage.get = async (key) => {
            const value = await get(key)
            if (key.endsWith(":settings.language") && !reading) {
                reading = true
                await held
            }
            return value
        }
        const recreated = createBuiltinHost({ storage })
        try {
            await recreated.start()
            const present = vi.fn()
            recreated.settingsCapability!.onDidRequestNavigation(present)
            await recreated.commands.execute("settings.language", { value: "en" })
            release()
            await vi.waitFor(async () => {
                expect(await recreated.settings.getValue("settings.language")).toBe("en")
                expect(recreated.settingsCapability!.settingsStore.language).toBe("en")
                expect(document.documentElement.lang).toBe("en")
            })
            expect(present).toHaveBeenCalledTimes(1)
        } finally {
            release()
            await recreated.dispose()
            vi.unstubAllGlobals()
            localStorage.clear()
        }
    })

    it.each([false, 0, ""])(
        "preserves saved falsy %s values during atomic initialization without synthetic ACKs",
        async (value) => {
            const storage = new MemoryStorageBackend()
            let registry!: SettingsRegistry
            const host = new ExtensionHost({
                storage,
                extensions: [
                    integrationExtension("builtin.initialization", (context) => {
                        registry = context.settings
                        context.settings.register({
                            id: "builtin.initialization.value",
                            label: "Value",
                            defaultValue: value,
                        })
                    }),
                ],
            })
            try {
                await host.start()
                await registry.setValue("builtin.initialization.value", value)
                const changes = vi.fn()
                registry.onDidChange(changes)
                const result = await registry.initializeValue(
                    "builtin.initialization.value",
                    "legacy",
                    Symbol("import"),
                )
                expect(result).toEqual({ initialized: false, value })
                expect(await registry.getValue("builtin.initialization.value")).toBe(value)
                expect(changes).not.toHaveBeenCalled()
            } finally {
                await host.dispose()
            }
        },
    )

    it("keeps initialization provenance observational and enforces permissions, ownership and validation", async () => {
        const storage = new MemoryStorageBackend()
        let registry!: SettingsRegistry
        let denied!: SettingsRegistry
        const forbidden = integrationExtension("community.denied", (context) => {
            denied = context.settings
        })
        const host = new ExtensionHost({
            storage,
            extensions: [
                integrationExtension("builtin.initialization", (context) => {
                    registry = context.settings
                    registry.register({
                        id: "builtin.initialization.value",
                        label: "Value",
                        defaultValue: 2,
                        editor: { kind: "number", min: 1, max: 5 },
                        validate: (value): value is number =>
                            typeof value === "number" && value !== 3,
                    })
                }),
                { ...forbidden, manifest: { ...forbidden.manifest, permissions: [] } },
            ],
        })
        try {
            await host.start()
            const provenance = Symbol("import")
            const changes = vi.fn()
            registry.onDidChange(changes)
            const set = vi.spyOn(storage, "set")
            expect(() =>
                denied.initializeValue("builtin.initialization.value", 4, provenance),
            ).toThrow("permission: settings")
            await expect(
                registry.initializeValue("community.denied.value", 4, provenance),
            ).rejects.toThrow("not registered")
            await expect(
                registry.initializeValue("builtin.initialization.value", 6, provenance),
            ).rejects.toThrow("Invalid value")
            await expect(
                registry.initializeValue("builtin.initialization.value", 3, provenance),
            ).rejects.toThrow("Invalid value")
            expect(changes).not.toHaveBeenCalled()
            expect(set).not.toHaveBeenCalled()
            expect(
                await registry.initializeValue("builtin.initialization.value", 4, provenance),
            ).toEqual({ initialized: true, value: 4 })
            expect(changes).toHaveBeenCalledExactlyOnceWith({
                kind: "value",
                settingId: "builtin.initialization.value",
                value: 4,
                provenance,
            })
            expect(await registry.getValue("builtin.initialization.value")).toBe(4)
            expect(
                await registry.initializeValue("builtin.initialization.value", 5, Symbol("other")),
            ).toEqual({ initialized: false, value: 4 })
            expect(changes).toHaveBeenCalledTimes(1)
        } finally {
            await host.dispose()
            vi.restoreAllMocks()
        }
    })

    it("fences an initialization read from a replacement setting declaration", async () => {
        const storage = new MemoryStorageBackend()
        let registry!: SettingsRegistry
        let registration!: { dispose(): void }
        const definition = {
            id: "builtin.initialization.value",
            label: "Value",
            defaultValue: "default",
        }
        const host = new ExtensionHost({
            storage,
            extensions: [
                integrationExtension("builtin.initialization", (context) => {
                    registry = context.settings
                    registration = registry.register(definition)
                }),
            ],
        })
        let release!: () => void
        const held = new Promise<void>((resolve) => {
            release = resolve
        })
        try {
            await host.start()
            const get = storage.get.bind(storage)
            let reading = false
            storage.get = async (key) => {
                const value = await get(key)
                if (key.endsWith(":builtin.initialization.value") && !reading) {
                    reading = true
                    await held
                }
                return value
            }
            const changes = vi.fn()
            registry.onDidChange(changes)
            const pending = registry.initializeValue(definition.id, "obsolete")
            const outcome = expect(pending).rejects.toThrow("no longer registered")
            await vi.waitFor(() => expect(reading).toBe(true))
            registration.dispose()
            registry.register(definition)
            changes.mockClear()
            release()
            await outcome
            expect(changes).not.toHaveBeenCalled()
            expect(await registry.getValue(definition.id)).toBe("default")
            expect(await registry.initializeValue(definition.id, "replacement")).toEqual({
                initialized: true,
                value: "replacement",
            })
        } finally {
            release()
            await host.dispose()
        }
    })

    it("propagates initialization read failures without writing or publishing defaults", async () => {
        const storage = new MemoryStorageBackend()
        let registry!: SettingsRegistry
        const host = new ExtensionHost({
            storage,
            extensions: [
                integrationExtension("builtin.initialization", (context) => {
                    registry = context.settings
                    registry.register({
                        id: "builtin.initialization.value",
                        label: "Value",
                        defaultValue: "default",
                    })
                }),
            ],
        })
        try {
            await host.start()
            const changes = vi.fn()
            registry.onDidChange(changes)
            const set = vi.spyOn(storage, "set")
            const get = storage.get.bind(storage)
            storage.get = async (key) => {
                if (key.endsWith(":builtin.initialization.value"))
                    throw new Error("read unavailable")
                return get(key)
            }
            await expect(
                registry.initializeValue("builtin.initialization.value", "legacy"),
            ).rejects.toThrow("read unavailable")
            expect(set).not.toHaveBeenCalled()
            expect(changes).not.toHaveBeenCalled()
            storage.get = get
            expect(await registry.getValue("builtin.initialization.value")).toBe("default")
        } finally {
            await host.dispose()
            vi.restoreAllMocks()
        }
    })

    it("keeps accepted writes authoritative when a delayed initial legacy read completes", async () => {
        localStorage.setItem("settings", JSON.stringify({ theme: "light" }))
        const storage = new MemoryStorageBackend()
        const get = storage.get.bind(storage)
        let release!: () => void
        const delayed = new Promise<void>((resolve) => {
            release = resolve
        })
        let held = false
        storage.get = async (key) => {
            const value = await get(key)
            if (key.endsWith(":settings.theme") && !held) {
                held = true
                await delayed
            }
            return value
        }
        const host = createBuiltinHost({ storage })
        try {
            await host.start()
            expect(held).toBe(true)
            await host.commands.execute("settings.theme", { value: "dark" })
            expect(host.settingsCapability!.settingsStore.theme).toBe("dark")
            release()
            await vi.waitFor(async () => {
                expect(await host.settings.getValue("settings.theme")).toBe("dark")
                expect(host.settingsCapability!.settingsStore.theme).toBe("dark")
                expect(document.documentElement.classList.contains("dark")).toBe(true)
            })
        } finally {
            release()
            await host.dispose()
            localStorage.clear()
        }
    })

    it("reports initial read rejection with legacy data without overwriting durable preferences", async () => {
        localStorage.setItem("settings", JSON.stringify({ theme: "light" }))
        const storage = new MemoryStorageBackend()
        await createExtensionStorage(storage, "builtin.settings").set("settings.theme", "dark")
        const get = storage.get.bind(storage)
        const set = storage.set.bind(storage)
        let writes = 0
        storage.get = async (key) => {
            if (key.endsWith(":settings.theme")) throw new Error("unavailable")
            return get(key)
        }
        storage.set = async (key, value) => {
            if (key.endsWith(":settings.theme")) writes++
            return set(key, value)
        }
        const host = createBuiltinHost({ storage })
        try {
            await host.start()
            expect(host.settingsCapability!.settingsStore.loadErrors.theme).toBeTruthy()
            expect(writes).toBe(0)
            storage.get = get
            expect(await host.settings.getValue("settings.theme")).toBe("dark")
            expect(writes).toBe(0)
        } finally {
            await host.dispose()
            localStorage.clear()
        }
    })

    it("fences disposed authority during delayed reads and writes and reconstructs acknowledged preferences", async () => {
        localStorage.clear()
        const storage = new MemoryStorageBackend()
        const get = storage.get.bind(storage)
        let releaseRead!: () => void
        const delayedRead = new Promise<void>((resolve) => {
            releaseRead = resolve
        })
        let reading = false
        storage.get = async (key) => {
            const value = await get(key)
            if (key.endsWith(":settings.scale") && !reading) {
                reading = true
                await delayedRead
            }
            return value
        }
        const host = createBuiltinHost({ storage })
        let releaseWrite!: () => void
        try {
            await host.start()
            const obsolete = host.settingsCapability!.settingsStore
            await host.commands.execute("settings.theme", { value: "dark" })
            const set = storage.set.bind(storage)
            let enter!: () => void
            const writing = new Promise<void>((resolve) => {
                enter = resolve
            })
            const delayedWrite = new Promise<void>((resolve) => {
                releaseWrite = resolve
            })
            storage.set = async (key, value) => {
                if (key.endsWith(":settings.quality")) {
                    enter()
                    await delayedWrite
                }
                return set(key, value)
            }
            const pending = host.settings.setValue("settings.quality", 1)
            const outcome = expect(pending).rejects.toThrow()
            await writing
            await host.dispose()
            releaseRead()
            releaseWrite()
            await outcome
            expect(obsolete.quality).toBe(3)
            expect(obsolete.scale).toBe(1.5)
            storage.get = get
            storage.set = set
            const recreated = createBuiltinHost({ storage })
            try {
                await recreated.start()
                expect(await recreated.settings.getValue("settings.theme")).toBe("dark")
                expect(recreated.settingsCapability!.settingsStore.theme).toBe("dark")
                expect(document.documentElement.classList.contains("dark")).toBe(true)
                // Already-admitted physical writes survive disposal, but never publish to the old adapter.
                expect(recreated.settingsCapability!.settingsStore.quality).toBe(1)
            } finally {
                await recreated.dispose()
            }
        } finally {
            releaseRead()
            releaseWrite?.()
            await host.dispose()
            localStorage.clear()
        }
    })

    it("does not turn the system motion default into a saved bootstrap choice", async () => {
        localStorage.clear()
        const host = createBuiltinHost({ storage: new MemoryStorageBackend() })
        try {
            await host.start()
            expect(JSON.parse(localStorage.getItem("settings") ?? "{}").animations).toBeUndefined()
        } finally {
            await host.dispose()
            localStorage.clear()
        }
    })

    it("queues Open Settings until presentation subscribes and fences replaced lifetimes", async () => {
        let capability!: SettingsCapability
        const host = new ExtensionHost({
            storage: new MemoryStorageBackend(),
            extensions: [
                {
                    manifest: BUILTIN_MANIFESTS.find(({ id }) => id === "builtin.settings")!,
                    activate: async (context) => {
                        await activateSettings(context)
                        capability = context.host!.settings!
                    },
                },
            ],
        })
        await host.start()
        await host.commands.execute("settings.open")
        await host.commands.execute("settings.open")
        let opens = 0
        const present = () => opens++
        const subscription = capability.onDidRequestOpen(present)
        expect(opens).toBe(1)
        await host.commands.execute("settings.open")
        expect(opens).toBe(2)
        const replacement = capability.onDidRequestOpen(present)
        subscription.dispose()
        await host.commands.execute("settings.open")
        expect(opens).toBe(3)
        replacement.dispose()
        capability.openSettings()
        const obsolete = capability
        await host.disable("builtin.settings")
        obsolete.openSettings()
        obsolete.onDidRequestOpen(() => opens++)
        expect(opens).toBe(3)
        await host.enable("builtin.settings")
        await host.activate("builtin.settings")
        capability.onDidRequestOpen(() => opens++)
        expect(opens).toBe(3)
        await host.commands.execute("settings.open")
        expect(opens).toBe(4)
        await host.dispose()
    })

    it("publishes preferences from catalog and commands only after durable acknowledgment", async () => {
        const storage = new MemoryStorageBackend()
        const host = createBuiltinHost({ storage })
        let release!: () => void
        let entered!: () => void
        const waiting = new Promise<void>((resolve) => {
            release = resolve
        })
        const writing = new Promise<void>((resolve) => {
            entered = resolve
        })
        const set = storage.set.bind(storage)
        let writes = 0
        try {
            await host.start()
            const store = settingsStore
            const original = store.theme
            storage.set = async (key, value) => {
                if (key.endsWith(":settings.theme")) {
                    writes++
                    entered()
                    await waiting
                }
                await set(key, value)
            }
            const pending = host.settings.setValue("settings.theme", "dark")
            await writing
            expect(store.theme).toBe(original)
            release()
            await pending
            expect(store.theme).toBe("dark")
            expect(document.documentElement.classList.contains("dark")).toBe(true)
            expect(writes).toBe(1)

            storage.set = async (key, value) => {
                if (key.endsWith(":settings.theme")) throw new Error("disk unavailable")
                await set(key, value)
            }
            await expect(
                host.commands.execute("settings.theme", { value: "light" }),
            ).rejects.toThrow()
            expect(store.theme).toBe("dark")
            expect(await host.settings.getValue("settings.theme")).toBe("dark")
            expect(document.documentElement.classList.contains("dark")).toBe(true)
        } finally {
            release?.()
            await host.dispose()
        }
    })

    it("applies language navigation and global motion through acknowledged catalog writes", async () => {
        const storage = new MemoryStorageBackend()
        const host = createBuiltinHost({ storage })
        const set = storage.set.bind(storage)
        let release!: () => void
        let entered!: () => void
        const waiting = new Promise<void>((resolve) => {
            release = resolve
        })
        const writing = new Promise<void>((resolve) => {
            entered = resolve
        })
        try {
            await host.start()
            const location = {
                href: "https://example.test/viewer?display=1#position",
                origin: "https://example.test",
                pathname: "/viewer",
                search: "?display=1",
                hash: "#position",
            }
            vi.stubGlobal("window", { location, matchMedia: window.matchMedia })
            const setLocale = vi.spyOn(localeRuntime, "setLocale")
            const original = settingsStore.language
            const language = original === "ru" ? "en" : "ru"
            storage.set = async (key, value) => {
                if (key.endsWith(":settings.language")) {
                    entered()
                    await waiting
                }
                await set(key, value)
            }
            const saving = host.settings.setValue("settings.language", language)
            await writing
            expect(settingsStore.language).toBe(original)
            expect(setLocale).not.toHaveBeenCalled()
            expect(location.href).toBe("https://example.test/viewer?display=1#position")
            release()
            await saving
            expect(settingsStore.language).toBe(language)
            expect(document.documentElement.lang).toBe(language)
            expect(document.cookie).toContain(`PARAGLIDE_LOCALE=${language}`)
            expect(setLocale).toHaveBeenCalledWith(language, { reload: false })
            expect(location.href).toBe(
                localeRuntime.localizeHref("/viewer?display=1#position", { locale: language }),
            )
            expect(localeRuntime.getLocale()).toBe(language)

            const motion = !settingsStore.animations
            await host.settings.setValue("settings.animations", motion)
            expect(settingsStore.animations).toBe(motion)
            expect(motionPreferences.enabled).toBe(motion)
            expect(document.documentElement.dataset.motion).toBe(motion ? "on" : "off")
            const bootstrap = localStorage.getItem("settings")
            storage.set = async () => {
                throw new Error("disk unavailable")
            }
            setLocale.mockClear()
            await expect(host.settings.setValue("settings.language", original)).rejects.toThrow()
            await expect(host.settings.setValue("settings.animations", !motion)).rejects.toThrow()
            expect(setLocale).not.toHaveBeenCalled()
            expect(settingsStore.language).toBe(language)
            expect(motionPreferences.enabled).toBe(motion)
            expect(localStorage.getItem("settings")).toBe(bootstrap)
        } finally {
            release?.()
            vi.unstubAllGlobals()
            vi.restoreAllMocks()
            await host.dispose()
        }
    })

    it("rebinds a live Reading workspace's Library access after provider reactivation", async () => {
        vi.stubGlobal("Blob", NodeBlob)
        vi.stubGlobal("URL", NodeURL)
        const storage = new MemoryStorageBackend()
        const library = createExtensionStorage(storage, "builtin.library").namespace("library")
        const addBook = async (id: string) => {
            await library.set(`books.${id}`, {
                id,
                name: `${id}.fake`,
                type: "file",
                parentId: null,
                createdAt: 1,
                updatedAt: 1,
                isPinned: false,
                metadata: { author: null, totalPages: 1 },
                size: 1,
            })
            await library.set(`fileContents.${id}`, { id, file: new Blob(["a"]) })
        }
        await addBook("first")
        const host = createBuiltinHost({ storage })
        host.documentService.adapters.register(integrationDocumentAdapter)
        try {
            await host.start()
            const workspace = viewerStore.workspace
            await workspace.open("first")
            expect(workspace.snapshot.documentId).toBe("first")
            await workspace.close()
            await host.disable("builtin.library")
            await addBook("second")
            await host.enable("builtin.library")
            await host.activate("builtin.library")
            await workspace.open("second")
            expect(workspace.snapshot.documentId).toBe("second")
        } finally {
            await host.dispose()
            vi.unstubAllGlobals()
        }
    })

    it("activates built-in startup extensions and lazy document extensions", async () => {
        const host = createBuiltinHost()

        await host.start()
        expect(host.records).toEqual(
            expect.arrayContaining(
                BUILTIN_MANIFESTS.map((manifest) =>
                    expect.objectContaining({
                        manifest,
                        state: manifest.id === "builtin.pdf" ? "enabled" : "active",
                    }),
                ),
            ),
        )

        await host.activateForDocumentType("pdf")
        expect(host.record("builtin.pdf")?.state).toBe("active")

        await host.dispose()
        expect(host.records.every((record) => record.state === "disposed")).toBe(true)
    })

    it("connects lifecycle, contribution registries, and namespaced storage", async () => {
        let firstStorage: ExtensionStorage | undefined
        let secondStorage: ExtensionStorage | undefined
        let disposed = false
        const first = integrationExtension("builtin.first", async (context) => {
            firstStorage = context.storage
            context.commands.register({
                id: "builtin.first.run",
                label: "Run",
                execute: () => "ok",
            })
            context.views.register({ id: "builtin.first.panel", slot: "workbench.panel" })
            context.settings.register({
                id: "builtin.first.enabled",
                label: "Enabled",
                defaultValue: true,
            })
            context.documents.register(integrationDocumentAdapter)
            await context.storage.namespace("state").set("value", "first")
            context.lifecycle.onDispose(() => {
                disposed = true
            })
        })
        const second = integrationExtension("builtin.second", async (context) => {
            secondStorage = context.storage
            await context.storage.namespace("state").set("value", "second")
        })
        const host = new ExtensionHost({
            extensions: [first, second],
            storage: new MemoryStorageBackend(),
        })

        await host.start()
        expect(host.contributions.listCommands()).toEqual([
            expect.objectContaining({ id: "builtin.first.run", extensionId: "builtin.first" }),
        ])
        expect(host.contributions.listViews()).toEqual([
            expect.objectContaining({ id: "builtin.first.panel", extensionId: "builtin.first" }),
        ])
        expect(host.contributions.listAdapters()).toEqual([
            expect.objectContaining({ id: "builtin.first.fake", extensionId: "builtin.first" }),
        ])
        expect(firstStorage).toBeDefined()
        expect(secondStorage).toBeDefined()
        await expect(firstStorage!.namespace("state").get("value")).resolves.toBe("first")
        await expect(secondStorage!.namespace("state").get("value")).resolves.toBe("second")
        await expect(firstStorage!.get("value")).resolves.toBeUndefined()

        await host.dispose()
        expect(disposed).toBe(true)
        expect(host.contributions.listCommands()).toEqual([])
        expect(host.contributions.listAdapters()).toEqual([])
    })
})
