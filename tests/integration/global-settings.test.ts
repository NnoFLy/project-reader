// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { flushSync, mount, unmount } from "svelte"
import { createBuiltinHost } from "$lib/extensions/builtin"
import { MemoryStorageBackend } from "$lib/core/storage"
import GlobalSettings from "$lib/app/settings/GlobalSettings.svelte"
import { setLocale } from "$lib/paraglide/runtime"
import * as m from "$lib/paraglide/messages"
import { ExtensionHost } from "$lib/extension-host"
import { BUILTIN_MANIFESTS } from "$lib/extensions/builtin"
import { activateSettings } from "$lib/extensions/builtin/settings"
import type { AppExtension, ExtensionContext } from "$lib/extension-api"

const plugin = (activate: AppExtension["activate"]): AppExtension => ({
    manifest: {
        id: "test.options",
        name: "Paper Tools",
        version: "1.0.0",
        engine: "*",
        entry: "options",
        activationEvents: [{ type: "startup" }],
        permissions: ["settings", "storage"],
    },
    activate,
})
const contribute = (context: ExtensionContext) => {
    context.settings.register({
        id: "test.options.text",
        label: "<b>Caption</b>",
        description: "Find by description",
        defaultValue: "saved",
        editor: { kind: "text", minLength: 2 },
        validate: (value): value is string => typeof value === "string" && value !== "forbidden",
    })
    context.settings.register({
        id: "test.options.number",
        label: "Count",
        defaultValue: 2,
        editor: { kind: "number", min: 0, max: 10, step: 2 },
    })
    context.settings.register({
        id: "test.options.boolean",
        label: "Enabled",
        defaultValue: false,
        editor: { kind: "boolean" },
    })
    context.settings.register({
        id: "test.options.choice",
        label: "Mode",
        defaultValue: 1,
        editor: {
            kind: "choice",
            choices: [
                { value: 1, label: "<img src=x>" },
                { value: 2, label: "Two" },
            ],
        },
    })
    context.settings.register({ id: "test.options.legacy", label: "Legacy", defaultValue: {} })
}
async function synthetic(storage = new MemoryStorageBackend()) {
    const host = new ExtensionHost({
        storage,
        extensions: [
            { manifest: BUILTIN_MANIFESTS[3], activate: activateSettings },
            plugin(contribute),
        ],
    })
    await host.start()
    await host.settings.setValue("settings.language", "en")
    return host
}
function input(name: string, value: string, commit = true) {
    const node = field(name)
    node.value = value
    node.dispatchEvent(new Event("input", { bubbles: true }))
    if (commit) node.dispatchEvent(new Event("change", { bubbles: true }))
}
function searchFor(value: string) {
    const search = document.querySelector('[type="search"]') as HTMLInputElement
    search.value = value
    search.dispatchEvent(new Event("input", { bubbles: true }))
    flushSync()
}

vi.hoisted(() => {
    window.matchMedia = (() => ({
        matches: false,
        addEventListener() {},
        removeEventListener() {},
    })) as unknown as typeof window.matchMedia
    window.requestAnimationFrame = (callback) => window.setTimeout(() => callback(0), 0)
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
const settle = async () => {
    await new Promise((resolve) => setTimeout(resolve, 5))
    flushSync()
}
const button = (name: string) =>
    [...document.querySelectorAll("button")].find((node) => node.textContent?.trim() === name)!
const field = (name: string) => {
    const label = [...document.querySelectorAll("label")].find(
        (node) => node.textContent?.trim() === name,
    )!
    if (!label) throw new Error(`Missing label ${name}: ${document.body.textContent}`)
    return document.getElementById(label.htmlFor) as HTMLInputElement
}
afterEach(() => {
    document.body.replaceChildren()
    localStorage.clear()
    vi.restoreAllMocks()
})
it("generates safe controls, retains invalid drafts across search, retries durable failures and guards close", async () => {
    const storage = new MemoryStorageBackend()
    const host = await synthetic(storage)
    const close = vi.fn()
    const component = mount(GlobalSettings, {
        target: document.body,
        props: { host, onClose: close },
    })
    const set = storage.set.bind(storage)
    try {
        await settle()
        searchFor("Paper Tools")
        await settle()
        expect(field("Count").value).toBe("2")
        expect(field("Enabled").type).toBe("checkbox")
        expect(field("Mode").tagName).toBe("SELECT")
        expect(document.querySelector("article b, article img")).toBeNull()
        expect(document.body.textContent).toContain("No supported editor")
        input("Count", "3")
        await settle()
        expect(field("Count").getAttribute("aria-invalid")).toBe("true")
        expect(await host.settings.getValue("test.options.number")).toBe(2)
        await host.settings.setValue("test.options.number", 8)
        await settle()
        expect(field("Count").value).toBe("3")
        searchFor("description")
        await settle()
        input("<b>Caption</b>", "forbidden")
        await settle()
        expect(await host.settings.getValue("test.options.text")).toBe("saved")
        storage.set = async (key, value) => {
            if (key.endsWith(":test.options.text")) throw new Error("secret disk detail")
            await set(key, value)
        }
        input("<b>Caption</b>", "attempted")
        await settle()
        expect(document.body.textContent).toContain("Not saved")
        expect(document.body.textContent).not.toContain("secret disk detail")
        expect(await host.settings.getValue("test.options.text")).toBe("saved")
        await component.requestClose()
        await settle()
        expect(document.querySelector('[role="alertdialog"]')).not.toBeNull()
        button("Stay").click()
        await settle()
        expect(field("<b>Caption</b>").value).toBe("attempted")
        storage.set = set
        button("Retry").click()
        await settle()
        expect(await host.settings.getValue("test.options.text")).toBe("attempted")
        searchFor("Count")
        await settle()
        expect(field("Count").value).toBe("3")
        button("Reset to default").click()
        await settle()
        expect(field("Count").value).toBe("2")
        await component.requestClose()
        await settle()
        expect(close).toHaveBeenCalledOnce()
    } finally {
        await unmount(component)
        await host.dispose()
    }
})

it("explains unavailable legacy editors in Russian without exposing internal diagnostics", async () => {
    const host = await synthetic()
    window.history.replaceState({}, "", "/")
    setLocale("ru", { reload: false })
    const component = mount(GlobalSettings, {
        target: document.body,
        props: { host, onClose() {} },
    })
    try {
        await settle()
        searchFor("Legacy")
        await settle()
        const article = document.querySelector("article")!
        expect(m.settings_unavailable()).toBe("Для этой настройки нет поддерживаемого редактора.")
        expect(article.textContent).toContain(m.settings_unavailable())
        expect(article.textContent).not.toContain("Missing editor metadata")
        expect(article.querySelector("input, select")).toBeNull()
    } finally {
        await unmount(component)
        await host.dispose()
    }
})

it("shows read failures without overwriting storage and retries only the captured read", async () => {
    const storage = new MemoryStorageBackend()
    const host = await synthetic(storage)
    const get = storage.get.bind(storage)
    const set = vi.spyOn(storage, "set")
    storage.get = async (key) => {
        if (key.endsWith(":test.options.text")) throw new Error("private read error")
        return get(key)
    }
    const component = mount(GlobalSettings, {
        target: document.body,
        props: { host, onClose() {} },
    })
    try {
        await settle()
        searchFor("Caption")
        await settle()
        expect(document.body.textContent).toContain("Could not load")
        expect(document.body.textContent).not.toContain("private read error")
        expect(document.querySelector("article input")).toBeNull()
        expect(set).not.toHaveBeenCalled()
        storage.get = get
        button("Retry").click()
        await settle()
        expect(field("<b>Caption</b>").value).toBe("saved")
        expect(set).not.toHaveBeenCalled()
    } finally {
        await unmount(component)
        await host.dispose()
    }
})

it("keeps the latest edit during delayed writes and awaits a failed pending close before discard", async () => {
    const storage = new MemoryStorageBackend()
    const host = await synthetic(storage)
    const close = vi.fn()
    const component = mount(GlobalSettings, {
        target: document.body,
        props: { host, onClose: close },
    })
    const set = storage.set.bind(storage)
    let release!: () => void
    let reject = false
    try {
        await settle()
        searchFor("Caption")
        await settle()
        storage.set = async (key, value) => {
            if (key.endsWith(":test.options.text")) {
                await new Promise<void>((resolve) => {
                    release = resolve
                })
                if (reject) throw new Error("write failed")
            }
            await set(key, value)
        }
        input("<b>Caption</b>", "first")
        await settle()
        input("<b>Caption</b>", "x", false)
        await settle()
        release()
        await settle()
        expect(field("<b>Caption</b>").value).toBe("x")
        expect(field("<b>Caption</b>").getAttribute("aria-invalid")).toBe("true")
        expect(await host.settings.getValue("test.options.text")).toBe("first")
        input("<b>Caption</b>", "second")
        await settle()
        const closing = component.requestClose()
        await settle()
        expect(close).not.toHaveBeenCalled()
        expect(document.querySelector('[role="alertdialog"]')).toBeNull()
        reject = true
        release()
        await closing
        await settle()
        expect(document.querySelector('[role="alertdialog"]')).not.toBeNull()
        button("Discard unsaved edits").click()
        await settle()
        expect(close).toHaveBeenCalledOnce()
        expect(await host.settings.getValue("test.options.text")).toBe("first")
    } finally {
        release?.()
        await unmount(component)
        await host.dispose()
    }
})

it("removes stale plugin drafts and pending retries, then reads fresh registrations on reactivation", async () => {
    const storage = new MemoryStorageBackend()
    const host = await synthetic(storage)
    const component = mount(GlobalSettings, {
        target: document.body,
        props: { host, onClose() {} },
    })
    const set = storage.set.bind(storage)
    let release!: () => void
    try {
        await settle()
        button("Plugins").click()
        await settle()
        button("Paper Tools").click()
        await settle()
        storage.set = async (key, value) => {
            if (key.endsWith(":test.options.text"))
                await new Promise<void>((resolve) => {
                    release = resolve
                })
            await set(key, value)
        }
        input("<b>Caption</b>", "old pending")
        await settle()
        await host.disable("test.options")
        await settle()
        expect(document.querySelector("article input")).toBeNull()
        expect(document.body.textContent).toContain("unsaved edits were discarded")
        searchFor("Caption")
        await settle()
        expect(document.body.textContent).toContain("No matching settings")
        release()
        await settle()
        storage.set = set
        await host.enable("test.options")
        await host.activate("test.options")
        await settle()
        expect(field("<b>Caption</b>").value).toBe("old pending")
        input("<b>Caption</b>", "fresh")
        await settle()
        expect(await host.settings.getValue("test.options.text")).toBe("fresh")
    } finally {
        release?.()
        await unmount(component)
        await host.dispose()
    }
})

it("routes Escape and singleton refocus through the retained unsaved confirmation", async () => {
    const host = await synthetic()
    const close = vi.fn()
    const component = mount(GlobalSettings, {
        target: document.body,
        props: { host, onClose: close },
    })
    try {
        await settle()
        searchFor("Count")
        await settle()
        input("Count", "3")
        await settle()
        ;(document.activeElement as HTMLElement)?.blur()
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
        await settle()
        const confirmation = document.querySelector('[role="alertdialog"]')!
        expect(confirmation).not.toBeNull()
        ;(document.querySelector('[type="search"]') as HTMLElement).focus()
        component.focus()
        expect(confirmation.contains(document.activeElement)).toBe(true)
        ;(document.activeElement as HTMLElement)?.blur()
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
        await settle()
        await vi.waitFor(() => expect(document.querySelector('[role="alertdialog"]')).toBeNull())
        expect(field("Count").value).toBe("3")
        expect(close).not.toHaveBeenCalled()
    } finally {
        await unmount(component)
        await host.dispose()
    }
})

it("retains failed reset defaults for Retry and reconstructs saved values in a new host", async () => {
    const storage = new MemoryStorageBackend()
    let host = await synthetic(storage)
    await host.settings.setValue("test.options.number", 8)
    let component = mount(GlobalSettings, { target: document.body, props: { host, onClose() {} } })
    const set = storage.set.bind(storage)
    try {
        await settle()
        searchFor("Count")
        await settle()
        expect(document.querySelector("article")?.textContent).toContain("Modified")
        storage.set = async (key, value) => {
            if (key.endsWith(":test.options.number")) throw new Error("reset error")
            await set(key, value)
        }
        button("Reset to default").click()
        await settle()
        expect(field("Count").value).toBe("2")
        expect(document.querySelector("article")?.textContent).toContain("Modified")
        expect(await host.settings.getValue("test.options.number")).toBe(8)
        storage.set = set
        button("Retry").click()
        await settle()
        expect(document.querySelector("article")?.textContent).not.toContain("Modified")
        expect(await host.settings.getValue("test.options.number")).toBe(2)
        input("Count", "6")
        await settle()
        await unmount(component)
        await host.dispose()
        host = await synthetic(storage)
        component = mount(GlobalSettings, { target: document.body, props: { host, onClose() {} } })
        await settle()
        searchFor("Count")
        await settle()
        expect(field("Count").value).toBe("6")
    } finally {
        storage.set = set
        await unmount(component)
        await host.dispose()
    }
})

it("waits for successful pending writes before closing and synchronizes clean command changes", async () => {
    const storage = new MemoryStorageBackend()
    const host = await synthetic(storage)
    const close = vi.fn()
    const component = mount(GlobalSettings, {
        target: document.body,
        props: { host, onClose: close },
    })
    const set = storage.set.bind(storage)
    let release!: () => void
    try {
        await settle()
        searchFor("Theme")
        await settle()
        await host.commands.execute("settings.theme", { value: "dark" })
        await settle()
        const theme = field("Theme") as unknown as HTMLSelectElement
        expect(theme.options[theme.selectedIndex].textContent).toBe("Dark")
        searchFor("Caption")
        await settle()
        storage.set = async (key, value) => {
            if (key.endsWith(":test.options.text"))
                await new Promise<void>((resolve) => {
                    release = resolve
                })
            await set(key, value)
        }
        input("<b>Caption</b>", "durable")
        await settle()
        const closing = component.requestClose()
        await settle()
        expect(close).not.toHaveBeenCalled()
        release()
        await closing
        await settle()
        expect(close).toHaveBeenCalledOnce()
        expect(document.querySelector('[role="alertdialog"]')).toBeNull()
        expect(await host.settings.getValue("test.options.text")).toBe("durable")
    } finally {
        release?.()
        await unmount(component)
        await host.dispose()
    }
})

it("browses real built-in categories and searches the complete catalog", async () => {
    setLocale("en", { reload: false })
    const host = createBuiltinHost({ storage: new MemoryStorageBackend() })
    await host.start()
    await host.settings.setValue("settings.language", "en")
    setLocale("en", { reload: false })
    const component = mount(GlobalSettings, {
        target: document.body,
        props: { host, onClose: vi.fn() },
    })
    try {
        await settle()
        expect(field("Language").value).toBe("1")
        button("Reading").click()
        await settle()
        expect(document.body.textContent).toContain("Default zoom")
        button("Plugins").click()
        await settle()
        expect(document.body.textContent).toContain("No plugin settings")
        const search = document.querySelector('[type="search"]') as HTMLInputElement
        search.value = "theme"
        search.dispatchEvent(new Event("input", { bubbles: true }))
        await settle()
        expect(field("Theme")).toBeTruthy()
        expect(document.body.textContent).toContain("Appearance")
        search.value = "nothing matches"
        search.dispatchEvent(new Event("input", { bubbles: true }))
        await settle()
        expect(document.body.textContent).toContain("No matching settings")
        button("Clear search").click()
        await settle()
        expect(search.value).toBe("")
    } finally {
        await unmount(component)
        await host.dispose()
    }
})
