// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { createRawSnippet, flushSync, mount, unmount, type Component } from "svelte"
import { ApplicationImpl } from "$lib/core/app/application"
import { createBuiltinHost } from "$lib/extensions/builtin"
import { Blob as NodeBlob } from "node:buffer"
import { URL as NodeURL } from "node:url"
import { viewerStore } from "$lib/extensions/builtin/viewer"
import { createExtensionStorage, MemoryStorageBackend } from "$lib/core/storage"
import AppChrome from "$lib/app/AppChrome.svelte"
import { APP_HOST_CONTEXT } from "$lib/app/hostContext"
import { openCommandPalette, promptStore } from "$lib/extensions/builtin/prompt"
import * as m from "$lib/paraglide/messages"

vi.mock("$app/environment", () => ({ version: "test", browser: true, dev: true, building: false }))
vi.mock("$app/navigation", () => ({
    afterNavigate: vi.fn(),
    goto: vi.fn(),
    pushState: vi.fn(),
    replaceState: vi.fn(),
}))
vi.mock("$app/state", () => ({
    updated: { current: false },
    page: { url: new URL("https://localhost/en") },
}))
vi.hoisted(() => {
    window.matchMedia = (() => ({
        matches: false,
        addEventListener() {},
        removeEventListener() {},
    })) as unknown as typeof window.matchMedia
    window.requestAnimationFrame = (callback) => window.setTimeout(() => callback(0), 0)
    Element.prototype.scrollIntoView = () => {}
    Element.prototype.scrollTo = () => {}
})
beforeEach(() => {
    window.history.replaceState({}, "", "/en")
    Element.prototype.animate = vi.fn(() => ({
        cancel() {},
        pause() {},
        play() {},
        finished: Promise.resolve(),
        set onfinish(callback: (() => void) | null) {
            if (callback) queueMicrotask(callback)
        },
        effect: { getComputedTiming: () => ({ progress: 1 }) },
    })) as unknown as typeof Element.prototype.animate
})
afterEach(() => {
    document.body.replaceChildren()
    localStorage.clear()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
})
const settle = async () => {
    await new Promise((resolve) => setTimeout(resolve, 20))
    flushSync()
}
const button = (name: string, scope: ParentNode = document) =>
    [...scope.querySelectorAll("button")].find((node) => node.textContent?.trim() === name)!
async function openReading() {
    button(m.settings_plugins()).click()
    await settle()
    button(m.settings_reading()).click()
}
const search = () => document.querySelector<HTMLInputElement>('[type="search"]')!
const settingRow = (label: string) =>
    document.querySelector<HTMLElement>(`article[aria-label="${label}"]`)!
const settingControl = (label: string) =>
    settingRow(label).querySelector<HTMLInputElement | HTMLSelectElement>("input, select")!
function editSetting(label: string, value: string | boolean) {
    const control = settingControl(label)
    if (typeof value === "boolean") (control as HTMLInputElement).checked = value
    else control.value = value
    control.dispatchEvent(new Event("input", { bubbles: true }))
    control.dispatchEvent(new Event("change", { bubbles: true }))
}
function captureLanguageNavigation() {
    const realWindow = window
    const location = {
        href: "http://localhost/en",
        origin: "http://localhost",
        pathname: "/en",
        search: "",
        hash: "",
    }
    vi.stubGlobal(
        "window",
        new Proxy(realWindow, {
            get(target, key) {
                if (key === "location") return location
                const value = Reflect.get(target, key, target)
                return typeof value === "function" ? value.bind(target) : value
            },
        }),
    )
    return location
}
async function setup(
    beforeMount?: (host: ReturnType<typeof createBuiltinHost>) => Promise<void>,
    storage = new MemoryStorageBackend(),
) {
    const host = createBuiltinHost({ storage })
    const application = new ApplicationImpl(host)
    await application.start()
    await host.settings.setValue("settings.language", "en")
    await beforeMount?.(host)
    const component = mount(AppChrome, {
        target: document.body,
        context: new Map([
            [
                APP_HOST_CONTEXT,
                { application, ready: true, services: { executeCommand: host.commands.execute } },
            ],
        ]),
        props: {
            children: createRawSnippet(() => ({
                render: () => '<main aria-label="Library"><header></header>Library</main>',
                setup(main) {
                    const header = main.querySelector("header")!
                    const updateTrigger = () => {
                        header.replaceChildren()
                        if (host.providers.get("builtin.settings")?.state !== "active") return
                        const trigger = document.createElement("button")
                        trigger.dataset.settingsTrigger = ""
                        trigger.textContent = "Settings"
                        trigger.setAttribute("aria-keyshortcuts", "Control+,")
                        trigger.onclick = () => host.settingsCapability?.openSettings()
                        header.append(trigger)
                    }
                    const subscription = host.providers.onDidChange((provider) => {
                        if (provider.extensionId === "builtin.settings") updateTrigger()
                    })
                    updateTrigger()
                    return () => subscription.dispose()
                },
            })),
        },
    })
    await settle()
    return {
        host,
        stop: async () => {
            await unmount(component)
            await application.stop()
        },
    }
}
it("restores focus to the header trigger when a command opener disconnects", async () => {
    const app = await setup()
    try {
        expect(document.querySelector(".app-settings-access")).toBeNull()
        const temporary = document.createElement("button")
        document.body.append(temporary)
        temporary.focus()
        await app.host.commands.execute("settings.open")
        temporary.remove()
        await settle()
        document.querySelector<HTMLButtonElement>('[aria-label="Close Settings"]')!.click()
        await settle()
        expect(document.activeElement).toBe(
            document.querySelector("header [data-settings-trigger]"),
        )
    } finally {
        await app.stop()
    }
})

it("applies generated Theme edits, restores the current choice, and durably resets only Theme", async () => {
    const storage = new MemoryStorageBackend()
    let app = await setup(undefined, storage)
    try {
        button("Settings").click()
        await settle()
        button("Appearance").click()
        await settle()
        expect((settingControl("Theme") as HTMLSelectElement).selectedOptions[0]!.text).toBe(
            "System",
        )
        editSetting("Theme", "1")
        await vi.waitFor(() =>
            expect(document.documentElement.classList.contains("dark")).toBe(true),
        )
        expect(await app.host.settings.getValue("settings.theme")).toBe("dark")
        expect(settingRow("Theme").textContent).toContain("Modified")
        document.querySelector<HTMLButtonElement>('[aria-label="Close Settings"]')!.click()
        await settle()
        await app.stop()
        app = await setup(undefined, storage)
        await app.host.commands.execute("settings.open")
        await settle()
        button("Appearance").click()
        await settle()
        expect((settingControl("Theme") as HTMLSelectElement).selectedOptions[0]!.text).toBe("Dark")
        expect(document.documentElement.classList.contains("dark")).toBe(true)
        await app.host.commands.execute("settings.theme", { value: "light" })
        await settle()
        expect((settingControl("Theme") as HTMLSelectElement).selectedOptions[0]!.text).toBe(
            "Light",
        )
        expect(document.documentElement.classList.contains("dark")).toBe(false)
        await app.host.commands.execute("settings.animations.toggle", { value: false })
        const reset = button("Reset to default", settingRow("Theme"))
        reset.click()
        await vi.waitFor(async () =>
            expect(await app.host.settings.getValue("settings.theme")).toBe("system"),
        )
        await settle()
        expect(settingRow("Theme").textContent).not.toContain("Modified")
        expect(await app.host.settings.getValue("settings.animations")).toBe(false)
        await app.stop()
        app = await setup(undefined, storage)
        button("Settings").click()
        await settle()
        button("Appearance").click()
        await settle()
        expect((settingControl("Theme") as HTMLSelectElement).selectedOptions[0]!.text).toBe(
            "System",
        )
        expect(settingRow("Theme").textContent).not.toContain("Modified")
        expect((settingControl("Animations") as HTMLInputElement).checked).toBe(false)
    } finally {
        await app.stop()
    }
})

it("waits for a held Theme rejection before guarding close and retains its failed draft across categories and commands", async () => {
    const storage = new MemoryStorageBackend()
    const app = await setup(async (host) => {
        await host.commands.execute("settings.theme", { value: "light" })
    }, storage)
    const set = storage.set.bind(storage)
    let release: (() => void) | undefined
    try {
        button("Settings").click()
        await settle()
        button("Appearance").click()
        await settle()
        storage.set = async (key, value) => {
            if (key.endsWith(":settings.theme")) {
                await new Promise<void>((resolve) => {
                    release = resolve
                })
                throw new Error("Theme write rejected")
            }
            await set(key, value)
        }
        editSetting("Theme", "1")
        await vi.waitFor(() => expect(release).toBeDefined())
        expect(settingControl("Theme").value).toBe("1")
        expect(settingRow("Theme").textContent).toContain("Saving")
        expect(document.documentElement.classList.contains("dark")).toBe(false)
        document.querySelector<HTMLButtonElement>('[aria-label="Close Settings"]')!.click()
        await settle()
        expect(document.querySelector('[role="alertdialog"]')).toBeNull()
        expect(document.querySelector('[role="dialog"]')).not.toBeNull()
        release!()
        await vi.waitFor(() =>
            expect(document.querySelector('[role="alertdialog"]')).not.toBeNull(),
        )
        button("Stay").click()
        await settle()
        expect(settingRow("Theme").textContent).toContain("Not saved")
        expect(await app.host.settings.getValue("settings.theme")).toBe("light")
        await openReading()
        await settle()
        button("Appearance").click()
        await settle()
        expect(settingControl("Theme").value).toBe("1")
        expect(settingRow("Theme").textContent).toContain("Not saved")
        storage.set = set
        await app.host.commands.execute("settings.theme", { value: "system" })
        await settle()
        expect(settingControl("Theme").value).toBe("1")
        expect(settingRow("Theme").textContent).toContain("Not saved")
        expect(document.documentElement.classList.contains("dark")).toBe(false)
        button("Retry").click()
        await vi.waitFor(() =>
            expect(document.documentElement.classList.contains("dark")).toBe(true),
        )
        expect(await app.host.settings.getValue("settings.theme")).toBe("dark")
        expect(settingRow("Theme").textContent).not.toContain("Not saved")
        document.querySelector<HTMLButtonElement>('[aria-label="Close Settings"]')!.click()
        await settle()
        expect(document.querySelector('[role="alertdialog"]')).toBeNull()
        expect(document.querySelector('[role="dialog"]')).toBeNull()
    } finally {
        release?.()
        await app.stop()
    }
})

it("retains the effective Theme and Modified indicator through a held failed reset, then retries only that preference", async () => {
    const storage = new MemoryStorageBackend()
    const app = await setup(async (host) => {
        await host.commands.execute("settings.theme", { value: "dark" })
        await host.commands.execute("settings.animations.toggle", { value: false })
    }, storage)
    const set = storage.set.bind(storage)
    let release: (() => void) | undefined
    try {
        button("Settings").click()
        await settle()
        button("Appearance").click()
        await settle()
        storage.set = async (key, value) => {
            if (key.endsWith(":settings.theme")) {
                await new Promise<void>((resolve) => {
                    release = resolve
                })
                throw new Error("Theme reset rejected")
            }
            await set(key, value)
        }
        button("Reset to default", settingRow("Theme")).click()
        await vi.waitFor(() => expect(release).toBeDefined())
        expect(settingControl("Theme").value).toBe("2")
        expect(settingRow("Theme").textContent).toContain("Saving")
        expect(settingRow("Theme").textContent).toContain("Modified")
        expect(document.documentElement.classList.contains("dark")).toBe(true)
        release!()
        await vi.waitFor(() => expect(settingRow("Theme").textContent).toContain("Not saved"))
        expect(settingRow("Theme").textContent).toContain("Modified")
        expect(await app.host.settings.getValue("settings.theme")).toBe("dark")
        expect(document.documentElement.classList.contains("dark")).toBe(true)
        storage.set = set
        button("Retry").click()
        await vi.waitFor(() => expect(settingRow("Theme").textContent).not.toContain("Modified"))
        expect(await app.host.settings.getValue("settings.theme")).toBe("system")
        expect(document.documentElement.classList.contains("dark")).toBe(false)
        expect((settingControl("Animations") as HTMLInputElement).checked).toBe(false)
        expect(await app.host.settings.getValue("settings.animations")).toBe(false)
    } finally {
        release?.()
        await app.stop()
    }
})

it("shows a Theme read failure without overwriting the saved choice and retries the read", async () => {
    const storage = new MemoryStorageBackend()
    const app = await setup(async (host) => {
        await host.commands.execute("settings.theme", { value: "dark" })
    }, storage)
    const get = storage.get.bind(storage)
    const writes: string[] = []
    const set = storage.set.bind(storage)
    try {
        storage.get = async (key) => {
            if (key.endsWith(":settings.theme")) throw new Error("Theme read unavailable")
            return get(key)
        }
        storage.set = async (key, value) => {
            writes.push(key)
            await set(key, value)
        }
        button("Settings").click()
        await settle()
        button("Appearance").click()
        await settle()
        expect(settingRow("Theme").textContent).toContain(m.settings_read_failed())
        expect(settingRow("Theme").querySelector("select")).toBeNull()
        expect(document.documentElement.classList.contains("dark")).toBe(true)
        expect(writes.filter((key) => key.endsWith(":settings.theme"))).toEqual([])
        storage.get = get
        button("Retry").click()
        await settle()
        expect((settingControl("Theme") as HTMLSelectElement).selectedOptions[0]!.text).toBe("Dark")
        expect(settingRow("Theme").textContent).not.toContain(m.settings_read_failed())
        expect(await app.host.settings.getValue("settings.theme")).toBe("dark")
        expect(writes.filter((key) => key.endsWith(":settings.theme"))).toEqual([])
    } finally {
        storage.get = get
        await app.stop()
    }
})

it("keeps the newest generated Theme choice while an earlier write completes", async () => {
    const storage = new MemoryStorageBackend()
    const app = await setup(async (host) => {
        await host.commands.execute("settings.theme", { value: "light" })
    }, storage)
    const set = storage.set.bind(storage)
    let release: (() => void) | undefined
    try {
        button("Settings").click()
        await settle()
        button("Appearance").click()
        await settle()
        storage.set = async (key, value) => {
            if (key.endsWith(":settings.theme") && !release)
                await new Promise<void>((resolve) => {
                    release = resolve
                })
            await set(key, value)
        }
        editSetting("Theme", "1")
        await vi.waitFor(() => expect(release).toBeDefined())
        editSetting("Theme", "2")
        await settle()
        expect(settingControl("Theme").value).toBe("2")
        expect(document.documentElement.classList.contains("dark")).toBe(false)
        release!()
        await vi.waitFor(async () =>
            expect(await app.host.settings.getValue("settings.theme")).toBe("system"),
        )
        await settle()
        expect(settingControl("Theme").value).toBe("2")
        expect(settingRow("Theme").textContent).not.toContain("Saving")
        expect(settingRow("Theme").textContent).not.toContain("Not saved")
        expect(document.documentElement.classList.contains("dark")).toBe(false)
        document.querySelector<HTMLButtonElement>('[aria-label="Close Settings"]')!.click()
        await settle()
        expect(document.querySelector('[role="dialog"]')).toBeNull()
    } finally {
        release?.()
        await app.stop()
    }
})

it("applies generated Animations edits to application motion and restores the acknowledged checkbox", async () => {
    const storage = new MemoryStorageBackend()
    let app = await setup(undefined, storage)
    try {
        button("Settings").click()
        await settle()
        button("Appearance").click()
        await settle()
        editSetting("Animations", false)
        await vi.waitFor(() => expect(document.documentElement.dataset.motion).toBe("off"))
        expect(await app.host.settings.getValue("settings.animations")).toBe(false)
        await app.stop()
        app = await setup(undefined, storage)
        button("Settings").click()
        await settle()
        button("Appearance").click()
        await settle()
        expect((settingControl("Animations") as HTMLInputElement).checked).toBe(false)
        expect(document.documentElement.dataset.motion).toBe("off")
        await app.host.commands.execute("settings.animations.toggle")
        await settle()
        expect((settingControl("Animations") as HTMLInputElement).checked).toBe(true)
        expect(document.documentElement.dataset.motion).toBe("on")
    } finally {
        await app.stop()
    }
})

it("updates real Library titles from the generated PDF title preference and restores it after recreation", async () => {
    const storage = new MemoryStorageBackend()
    const libraryStorage = createExtensionStorage(storage, "builtin.library").namespace("library")
    await libraryStorage.set("books.title", {
        id: "title",
        name: "filename.pdf",
        type: "file",
        parentId: null,
        createdAt: 1,
        updatedAt: 1,
        isPinned: false,
        size: 1,
        metadata: { pdfTitle: "Embedded title", author: "Author", totalPages: 1 },
    })
    let app = await setup(undefined, storage)
    const mountLibrary = () => {
        const View = app.host.contributions
            .listViews("workbench.panel")
            .find((view) => view.id === "library.page")!.component as Component
        return mount(View, { target: document.querySelector("main")! })
    }
    let library = mountLibrary()
    try {
        await vi.waitFor(() =>
            expect(document.querySelector("main")!.textContent).toContain("Embedded title"),
        )
        const libraryTrigger = document.querySelector<HTMLButtonElement>(
            "main .global-settings-trigger",
        )!
        expect(libraryTrigger.getAttribute("aria-keyshortcuts")).toBe("Control+,")
        expect(libraryTrigger.getAttribute("aria-label")).toBe(m.settings())
        expect(libraryTrigger.textContent?.trim()).toBe(m.settings())
        expect(libraryTrigger.querySelector("svg")).not.toBeNull()
        libraryTrigger.click()
        await settle()
        button("Library").click()
        await settle()
        editSetting("Prefer embedded PDF titles", false)
        await vi.waitFor(() => {
            expect(document.querySelector("main")!.textContent).toContain("filename.pdf")
            expect(document.querySelector("main")!.textContent).not.toContain("Embedded title")
        })
        expect(await app.host.settings.getValue("settings.prefer-pdf-title")).toBe(false)
        await unmount(library)
        await app.stop()
        app = await setup(undefined, storage)
        library = mountLibrary()
        await vi.waitFor(() =>
            expect(document.querySelector("main")!.textContent).toContain("filename.pdf"),
        )
        await app.host.commands.execute("settings.open")
        await settle()
        button("Library").click()
        await settle()
        expect((settingControl("Prefer embedded PDF titles") as HTMLInputElement).checked).toBe(
            false,
        )
        await app.host.commands.execute("settings.pdf-title.toggle")
        await vi.waitFor(() =>
            expect(document.querySelector("main")!.textContent).toContain("Embedded title"),
        )
        expect((settingControl("Prefer embedded PDF titles") as HTMLInputElement).checked).toBe(
            true,
        )
    } finally {
        await unmount(library)
        await app.stop()
    }
})

it.each([
    ["Default page layout", "settings.layout", "0", "single", "settings.layout", "split", "1"],
    ["Default zoom", "settings.scale", "2.25", 2.25, "settings.zoom.in", 1.75, "1.75"],
    ["Render quality", "settings.quality", "4", 4, "settings.quality.out", 2, "2"],
] as const)(
    "durably restores the generated %s edit and synchronizes its existing command",
    async (label, id, input, saved, command, commandValue, expectedInput) => {
        const storage = new MemoryStorageBackend()
        let app = await setup(undefined, storage)
        try {
            button("Settings").click()
            await settle()
            await openReading()
            await settle()
            editSetting(label, input)
            await vi.waitFor(async () => expect(await app.host.settings.getValue(id)).toBe(saved))
            await app.stop()
            app = await setup(undefined, storage)
            await app.host.commands.execute("settings.open")
            await settle()
            await openReading()
            await settle()
            expect(settingControl(label).value).toBe(input)
            expect(settingRow(label).textContent).toContain("Modified")
            await app.host.commands.execute(command, { value: commandValue })
            await settle()
            expect(settingControl(label).value).toBe(expectedInput)
            expect(await app.host.settings.getValue(id)).toBe(commandValue)
        } finally {
            await app.stop()
        }
    },
)

it("defers language navigation through pending writes, Stay, and a later accepted dismissal", async () => {
    const storage = new MemoryStorageBackend()
    const app = await setup(undefined, storage)
    const realWindow = window
    const location = {
        href: "http://localhost/en?keep=1#position",
        origin: "http://localhost",
        pathname: "/en",
        search: "?keep=1",
        hash: "#position",
    }
    vi.stubGlobal(
        "window",
        new Proxy(realWindow, {
            get(target, key) {
                if (key === "location") return location
                const value = Reflect.get(target, key, target)
                return typeof value === "function" ? value.bind(target) : value
            },
        }),
    )
    const set = storage.set.bind(storage)
    let release: (() => void) | undefined
    let pending: Promise<unknown> | undefined
    try {
        button("Settings").click()
        await settle()
        await openReading()
        await settle()
        const zoom = document.querySelector<HTMLInputElement>('input[type="number"]')!
        zoom.value = "99"
        zoom.dispatchEvent(new Event("input", { bubbles: true }))
        zoom.dispatchEvent(new Event("change", { bubbles: true }))
        storage.set = async (key, value) => {
            if (key.endsWith(":settings.quality"))
                await new Promise<void>((resolve) => {
                    release = resolve
                })
            await set(key, value)
        }
        pending = app.host.commands.execute("settings.quality.in")
        await vi.waitFor(() => expect(release).toBeDefined())
        button("General").click()
        await settle()
        const language = document.querySelector<HTMLSelectElement>("select")!
        language.value = "0"
        language.dispatchEvent(new Event("change", { bubbles: true }))
        await vi.waitFor(() =>
            expect(app.host.settingsCapability!.settingsStore.language).toBe("ru"),
        )
        // The ACK is not held hostage by the dismissal decision or unrelated write.
        expect(await app.host.settings.getValue("settings.language")).toBe("ru")
        expect(document.documentElement.lang).toBe("ru")
        expect(document.cookie).toContain("PARAGLIDE_LOCALE=ru")
        expect(location.href).toBe("http://localhost/en?keep=1#position")
        expect(document.querySelector('[role="alertdialog"]')).toBeNull()
        release!()
        await pending
        await settle()
        expect(document.querySelector('[role="alertdialog"]')).not.toBeNull()
        button(m.settings_stay()).click()
        await settle()
        expect(location.href).toBe("http://localhost/en?keep=1#position")
        const replacement = promptStore.open({ id: "language-replacement", items: () => [] })
        await app.host.commands.execute("settings.language", { value: "ru" })
        await settle()
        expect(promptStore.snapshot?.request.id).toBe("language-replacement")
        expect(document.querySelector('[role="alertdialog"]')).toBeNull()
        expect(location.href).toBe("http://localhost/en?keep=1#position")
        promptStore.close()
        await replacement
        await settle()
        await openReading()
        await settle()
        expect(document.querySelector<HTMLInputElement>('input[type="number"]')!.value).toBe("99")
        document.querySelector<HTMLButtonElement>(`[aria-label="${m.settings_close()}"]`)!.click()
        await settle()
        button(m.settings_discard()).click()
        await settle()
        expect(location.href).toBe("/?keep=1#position")
        expect(document.querySelector('[role="dialog"]')).toBeNull()
        expect(await app.host.settings.getValue("settings.quality")).toBe(4)
    } finally {
        release?.()
        await pending
        await app.stop()
    }
})

it.each([false, true])(
    "retains failed language drafts but navigates the latest saved locale (new success: %s)",
    async (newSuccess) => {
        const storage = new MemoryStorageBackend()
        const app = await setup(undefined, storage)
        const location = captureLanguageNavigation()
        const set = storage.set.bind(storage)
        try {
            button("Settings").click()
            await settle()
            await openReading()
            await settle()
            const zoom = document.querySelector<HTMLInputElement>('input[type="number"]')!
            zoom.value = "99"
            zoom.dispatchEvent(new Event("input", { bubbles: true }))
            await app.host.commands.execute("settings.language", { value: "ru" })
            await settle()
            button(m.settings_stay()).click()
            await settle()
            button(m.settings_general()).click()
            await settle()
            storage.set = async (key, value) => {
                if (key.endsWith(":settings.language")) throw new Error("language failure")
                await set(key, value)
            }
            const language = document.querySelector<HTMLSelectElement>("select")!
            language.value = "1"
            language.dispatchEvent(new Event("change", { bubbles: true }))
            await settle()
            expect(document.body.textContent).toContain(m.settings_not_saved())
            expect(language.value).toBe("1")
            if (newSuccess) {
                storage.set = set
                await app.host.commands.execute("settings.language", { value: "ru" })
                await settle()
                button(m.settings_stay()).click()
                await settle()
            } else {
                await expect(
                    app.host.commands.execute("settings.language", { value: "en" }),
                ).rejects.toThrow()
            }
            expect(await app.host.settings.getValue("settings.language")).toBe("ru")
            expect(location.href).toBe("http://localhost/en")
            expect(language.value).toBe("1")
            expect(document.body.textContent).toContain(m.settings_not_saved())
            document
                .querySelector<HTMLButtonElement>(`[aria-label="${m.settings_close()}"]`)!
                .click()
            await settle()
            button(m.settings_discard()).click()
            await settle()
            expect(location.href).toBe("/")
        } finally {
            await app.stop()
        }
    },
)

it("cancels a deferred destination when the current URL language is successfully selected", async () => {
    const app = await setup()
    const location = captureLanguageNavigation()
    try {
        button("Settings").click()
        await settle()
        await openReading()
        await settle()
        const zoom = document.querySelector<HTMLInputElement>('input[type="number"]')!
        zoom.value = "99"
        zoom.dispatchEvent(new Event("input", { bubbles: true }))
        await app.host.commands.execute("settings.language", { value: "ru" })
        await settle()
        button(m.settings_stay()).click()
        await settle()
        await app.host.commands.execute("settings.language", { value: "en" })
        await settle()
        expect(document.querySelector('[role="alertdialog"]')).toBeNull()
        expect(document.querySelector('[role="dialog"]')).not.toBeNull()
        document.querySelector<HTMLButtonElement>('[aria-label="Close Settings"]')!.click()
        await settle()
        button("Discard unsaved edits").click()
        await settle()
        expect(location.href).toBe("http://localhost/en")
        expect(await app.host.settings.getValue("settings.language")).toBe("en")
    } finally {
        await app.stop()
    }
})

it("does not navigate when the host is replaced while a language dismissal awaits an unrelated write", async () => {
    const storage = new MemoryStorageBackend()
    const app = await setup(undefined, storage)
    const location = captureLanguageNavigation()
    const set = storage.set.bind(storage)
    let release: (() => void) | undefined
    let pending: Promise<unknown> | undefined
    try {
        button("Settings").click()
        await settle()
        storage.set = async (key, value) => {
            if (key.endsWith(":settings.quality"))
                await new Promise<void>((resolve) => {
                    release = resolve
                })
            await set(key, value)
        }
        pending = app.host.commands.execute("settings.quality.in").catch(() => undefined)
        await vi.waitFor(() => expect(release).toBeDefined())
        await app.host.commands.execute("settings.language", { value: "ru" })
        await settle()
        await app.host.disable("builtin.settings")
        release!()
        await pending
        await settle()
        await app.host.enable("builtin.settings")
        await app.host.activate("builtin.settings")
        await settle()
        expect(location.href).toBe("http://localhost/en")
        expect(document.querySelector('[role="dialog"]')).toBeNull()
    } finally {
        release?.()
        await pending
        await app.stop()
    }
})

it("preserves both held relative quality commands in the mounted acknowledged control", async () => {
    const storage = new MemoryStorageBackend()
    const app = await setup(undefined, storage)
    const set = storage.set.bind(storage)
    let release: (() => void) | undefined
    try {
        button("Settings").click()
        await settle()
        await openReading()
        await settle()
        const quality = () => {
            const label = [...document.querySelectorAll("label")].find(
                (node) => node.textContent === "Render quality",
            )!
            return document.getElementById(label.htmlFor) as HTMLInputElement
        }
        storage.set = async (key, value) => {
            if (key.endsWith(":settings.quality") && !release)
                await new Promise<void>((resolve) => {
                    release = resolve
                })
            await set(key, value)
        }
        const first = app.host.commands.execute("settings.quality.in")
        await vi.waitFor(() => expect(release).toBeDefined())
        const second = app.host.commands.execute("settings.quality.in")
        await settle()
        expect(quality().value).toBe("3")
        expect(app.host.settingsCapability!.settingsStore.quality).toBe(3)
        release!()
        await Promise.all([first, second])
        await settle()
        expect(quality().value).toBe("5")
        expect(await app.host.settings.getValue("settings.quality")).toBe(5)
    } finally {
        release?.()
        await app.stop()
    }
})

it.each([
    ["settings.animations.toggle", "settings.animations", "Animations", undefined],
    ["settings.pdf-title.toggle", "settings.prefer-pdf-title", "Prefer embedded PDF titles", true],
    ["settings.layout", "settings.layout", "Default page layout", "split"],
    ["settings.zoom.in", "settings.scale", "Default zoom", 1.7],
    ["settings.zoom.out", "settings.scale", "Default zoom", 1.3],
    ["settings.quality.out", "settings.quality", "Render quality", 1],
] as const)(
    "serializes held relative %s evaluation and acknowledgment",
    async (command, id, label, expected) => {
        const storage = new MemoryStorageBackend()
        const app = await setup(undefined, storage)
        const set = storage.set.bind(storage)
        const original = await app.host.settings.getValue(id)
        let release: (() => void) | undefined
        let results: Promise<PromiseSettledResult<unknown>[]> | undefined
        try {
            button("Settings").click()
            await settle()
            search().value = label
            search().dispatchEvent(new Event("input", { bubbles: true }))
            await settle()
            storage.set = async (key, value) => {
                if (key.endsWith(`:${id}`) && !release)
                    await new Promise<void>((resolve) => {
                        release = resolve
                    })
                await set(key, value)
            }
            const first = app.host.commands.execute(command)
            await vi.waitFor(() => expect(release).toBeDefined())
            const second = app.host.commands.execute(command)
            results = Promise.allSettled([first, second])
            await settle()
            const control = () =>
                document.querySelector<HTMLInputElement | HTMLSelectElement>(
                    "article input, article select",
                )!
            expect(control()).not.toBeNull()
            if (control().type === "checkbox")
                expect((control() as HTMLInputElement).checked).toBe(original)
            release!()
            expect((await results).map((result) => result.status)).toEqual([
                "fulfilled",
                "fulfilled",
            ])
            await settle()
            expect(await app.host.settings.getValue(id)).toBe(expected ?? original)
            if (control().type === "checkbox")
                expect((control() as HTMLInputElement).checked).toBe(expected ?? original)
            else if (id === "settings.layout")
                expect((control() as HTMLSelectElement).selectedIndex).toBe(1)
            else expect(control().value).toBe(String(expected))
        } finally {
            release?.()
            await results
            await app.stop()
        }
    },
)

it("recovers the relative queue after a held rejection without publishing the failed increment", async () => {
    const storage = new MemoryStorageBackend()
    const app = await setup(undefined, storage)
    const set = storage.set.bind(storage)
    let release: (() => void) | undefined
    let results: Promise<PromiseSettledResult<unknown>[]> | undefined
    try {
        button("Settings").click()
        await settle()
        await openReading()
        await settle()
        storage.set = async (key, value) => {
            if (key.endsWith(":settings.quality") && !release) {
                await new Promise<void>((resolve) => {
                    release = resolve
                })
                throw new Error("held failure")
            }
            await set(key, value)
        }
        const first = app.host.commands.execute("settings.quality.in")
        await vi.waitFor(() => expect(release).toBeDefined())
        const second = app.host.commands.execute("settings.quality.in")
        results = Promise.allSettled([first, second])
        expect(app.host.settingsCapability!.settingsStore.quality).toBe(3)
        release!()
        expect((await results).map((result) => result.status)).toEqual(["rejected", "fulfilled"])
        await settle()
        expect(await app.host.settings.getValue("settings.quality")).toBe(4)
        expect(app.host.settingsCapability!.settingsStore.quality).toBe(4)
        expect(document.querySelectorAll<HTMLInputElement>('input[type="number"]')[1]!.value).toBe(
            "4",
        )
    } finally {
        release?.()
        await results
        await app.stop()
    }
})

it("keeps app Settings available alongside a mounted reader and its selected-session controls", async () => {
    vi.stubGlobal(
        "ResizeObserver",
        class {
            observe() {}
            unobserve() {}
            disconnect() {}
        },
    )
    vi.stubGlobal("Blob", NodeBlob)
    vi.stubGlobal("URL", NodeURL)
    const storage = new MemoryStorageBackend()
    const library = createExtensionStorage(storage, "builtin.library").namespace("library")
    await library.set("books.book", {
        id: "book",
        name: "book.fake",
        type: "file",
        parentId: null,
        createdAt: 1,
        updatedAt: 1,
        isPinned: false,
        metadata: { author: null, totalPages: 1 },
        size: 1,
    })
    await library.set("fileContents.book", { id: "book", file: new Blob(["a"]) })
    const app = await setup(async (host) => {
        host.documentService.adapters.register({
            id: "integration.reader",
            extensions: ["fake"],
            mimeTypes: [],
            probe: async () => ({ supported: true }),
            open: async () => ({
                kind: "paged",
                metadata: { title: "Reader", author: null },
                capabilities: new Set(),
                pageCount: 1,
                getPage: async (pageNumber) => ({ pageNumber, width: 600, height: 800 }),
                renderPage: async (pageNumber) => ({
                    pageNumber,
                    width: 600,
                    height: 800,
                    url: "data:image/png;base64,",
                    mimeType: "image/png",
                }),
                close: async () => {},
            }),
        })
        await viewerStore.workspace.open("book")
    }, storage)
    const View = app.host.contributions.listViews("viewer.toolbar")[0]!.component as Component
    const reader = mount(View, { target: document.querySelector("main")! })
    try {
        await vi.waitFor(() =>
            expect(document.querySelector('[aria-label="Reading controls"]')).not.toBeNull(),
        )
        const controls = document.querySelector<HTMLButtonElement>(
            '[aria-label="Reading controls"]',
        )!
        controls.click()
        await settle()
        expect(document.querySelector('[aria-label="Zoom scale"]')).not.toBeNull()
        const opener = document.querySelector<HTMLButtonElement>('header [aria-label="Settings"]')!
        opener.focus()
        opener.click()
        await settle()
        expect(document.querySelector('[aria-label="Close Settings"]')).not.toBeNull()
        expect(document.querySelector('[aria-label="Reading controls"]')).not.toBeNull()
        document.querySelector<HTMLButtonElement>('[aria-label="Close Settings"]')!.click()
        await settle()
        expect(document.activeElement).toBe(opener)
    } finally {
        await unmount(reader)
        await app.stop()
    }
})
it("delivers queued opens and fences disabled presenters and mounted stale drafts on reactivation", async () => {
    const app = await setup(async (host) => {
        await host.commands.execute("settings.open")
        await host.commands.execute("settings.open")
    })
    try {
        expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1)
        await openReading()
        await settle()
        const zoom = document.querySelector<HTMLInputElement>('input[type="number"]')!
        zoom.value = "99"
        zoom.dispatchEvent(new Event("input", { bubbles: true }))
        zoom.dispatchEvent(new Event("change", { bubbles: true }))
        await settle()
        const stale = app.host.settingsCapability!
        await app.host.disable("builtin.settings")
        await settle()
        expect(document.querySelector('[role="dialog"]')).toBeNull()
        expect(button("Settings")).toBeUndefined()
        stale.openSettings()
        await settle()
        expect(document.querySelector('[role="dialog"]')).toBeNull()
        await app.host.enable("builtin.settings")
        await app.host.activate("builtin.settings")
        await settle()
        stale.openSettings()
        await settle()
        expect(document.querySelector('[role="dialog"]')).toBeNull()
        button("Settings").click()
        await settle()
        await openReading()
        await settle()
        expect(document.querySelector<HTMLInputElement>('input[type="number"]')!.value).toBe("1.5")
        expect(document.body.textContent).not.toContain("Discard unsaved edits")
    } finally {
        await app.stop()
    }
})
it("dismisses the actual Command palette on Open Settings and leaves an unrelated replacement Prompt intact", async () => {
    const app = await setup()
    try {
        button("Settings").focus()
        const palette = openCommandPalette(undefined, "Open Settings")
        await settle()
        expect(promptStore.snapshot?.items[0]?.id).toBe("settings.open")
        await promptStore.selectCurrent()
        await palette
        await settle()
        expect(promptStore.isOpen).toBe(false)
        expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1)
        const close = document.querySelector<HTMLButtonElement>('[aria-label="Close Settings"]')!
        close.click()
        await settle()
        expect(document.activeElement).toBe(button("Settings"))

        const secondPalette = openCommandPalette(undefined, "Open Settings")
        await settle()
        const selection = promptStore.selectCurrent()
        const replacement = promptStore.open({ id: "unrelated", items: () => [] })
        await selection
        await secondPalette
        await settle()
        expect(promptStore.snapshot?.request.id).toBe("unrelated")
        expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(2)
        document.querySelector<HTMLButtonElement>('[aria-label="Close Settings"]')!.click()
        await settle()
        expect(promptStore.snapshot?.request.id).toBe("unrelated")
        promptStore.close()
        await replacement
    } finally {
        await app.stop()
    }
})
it("opens app Settings without a document and refocuses the singleton retaining attempted edits", async () => {
    const app = await setup()
    try {
        const opener = button("Settings")
        expect(opener).toBeDefined()
        opener.focus()
        opener.click()
        await settle()
        expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1)
        await openReading()
        await settle()
        const label = [...document.querySelectorAll("label")].find(
            (node) => node.textContent === "Default zoom",
        )!
        const zoom = document.getElementById(label.htmlFor) as HTMLInputElement
        zoom.value = "99"
        zoom.dispatchEvent(new Event("input", { bubbles: true }))
        zoom.dispatchEvent(new Event("change", { bubbles: true }))
        await settle()
        await app.host.commands.execute("settings.open")
        await settle()
        expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1)
        expect(document.getElementById(label.htmlFor)).toBe(zoom)
        expect(zoom.value).toBe("99")
        expect(document.activeElement).toBe(search())
        search().blur()
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
        await settle()
        expect(document.body.textContent).toContain("Discard unsaved edits")
        button("Stay").click()
        await settle()
        expect(zoom.value).toBe("99")
        search().blur()
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
        await settle()
        button("Discard unsaved edits").click()
        await settle()
        expect(document.querySelector('[role="dialog"]')).toBeNull()
        expect(document.activeElement).toBe(opener)
    } finally {
        await app.stop()
    }
})
