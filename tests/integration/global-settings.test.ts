// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { flushSync, mount, unmount } from "svelte"
import { createBuiltinHost } from "$lib/extensions/builtin"
import { MemoryStorageBackend } from "$lib/core/storage"
import GlobalSettings from "$lib/app/settings/GlobalSettings.svelte"
import { getLocale, setLocale } from "$lib/paraglide/runtime"
import * as m from "$lib/paraglide/messages"
import { ExtensionHost } from "$lib/extension-host"
import { BUILTIN_MANIFESTS } from "$lib/extensions/builtin"
import { activateSettings } from "$lib/extensions/builtin/settings"
import type { AppExtension, ExtensionContext } from "$lib/extension-api"

const plugin = (
    activate: AppExtension["activate"],
    id = "test.options",
    name = "Paper Tools",
    activationEvents: AppExtension["manifest"]["activationEvents"] = [{ type: "startup" }],
): AppExtension => ({
    manifest: {
        id,
        name,
        version: "1.0.0",
        engine: "*",
        entry: "options",
        activationEvents,
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
async function synthetic(storage = new MemoryStorageBackend(), extensions: AppExtension[] = []) {
    const host = new ExtensionHost({
        storage,
        extensions: [
            { manifest: BUILTIN_MANIFESTS[3], activate: activateSettings },
            plugin(contribute),
            ...extensions,
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

it.each([
    { label: "Enabled", id: "boolean", edited: true, saved: true, defaultValue: false },
    { label: "Mode", id: "choice", edited: "1", saved: 2, defaultValue: 1 },
    {
        label: "<b>Caption</b>",
        id: "text",
        edited: "custom caption",
        saved: "custom caption",
        defaultValue: "saved",
    },
    { label: "Count", id: "number", edited: "8", saved: 8, defaultValue: 2 },
])(
    "persists $id edits and resets at the declared default without changing other preferences",
    async ({ label, id, edited, saved, defaultValue }) => {
        const storage = new MemoryStorageBackend()
        const other = plugin(
            (context) => {
                context.settings.register({
                    id: "test.other.caption",
                    label: "Other caption",
                    defaultValue: "original",
                    editor: { kind: "text" },
                })
            },
            "test.other",
            "Other Tools",
        )
        let host = await synthetic(storage, [other])
        await host.settings.setValue("test.other.caption", "keep other plugin")
        await host.commands.execute("settings.theme", { value: "dark" })
        const unrelatedId = id === "text" ? "test.options.number" : "test.options.text"
        const unrelatedValue = id === "text" ? 6 : "keep same plugin"
        await host.settings.setValue(unrelatedId, unrelatedValue)
        const close = vi.fn()
        let component = mount(GlobalSettings, {
            target: document.body,
            props: { host, onClose: close },
        })
        const row = () => field(label).closest("article")!
        const expectControl = (value: unknown) => {
            if (id === "boolean") expect(field(label).checked).toBe(value)
            else if (id === "choice") expect(field(label).value).toBe(value === 1 ? "0" : "1")
            else expect(field(label).value).toBe(String(value))
        }
        try {
            await settle()
            button("Plugins").click()
            await settle()
            button("Paper Tools").click()
            await settle()
            expectControl(defaultValue)
            expect(row().textContent).not.toContain("Modified")
            if (typeof edited === "boolean") field(label).click()
            else input(label, edited)
            await settle()
            expectControl(saved)
            expect(await host.settings.getValue(`test.options.${id}`)).toBe(saved)
            expect(row().textContent).toContain("Modified")
            await component.requestClose()
            expect(close).toHaveBeenCalledOnce()
            await unmount(component)
            await host.dispose()
            host = await synthetic(storage, [other])
            component = mount(GlobalSettings, {
                target: document.body,
                props: { host, onClose: close },
            })
            await settle()
            searchFor(label)
            await settle()
            expectControl(saved)
            expect(row().textContent).toContain("Modified")
            button("Reset to default").click()
            await settle()
            expectControl(defaultValue)
            expect(await host.settings.getValue(`test.options.${id}`)).toBe(defaultValue)
            expect(row().textContent).not.toContain("Modified")
            expect(await host.settings.getValue(unrelatedId)).toBe(unrelatedValue)
            expect(await host.settings.getValue("test.other.caption")).toBe("keep other plugin")
            expect(await host.settings.getValue("settings.theme")).toBe("dark")
            await component.requestClose()
            expect(close).toHaveBeenCalledTimes(2)
            await unmount(component)
            component = mount(GlobalSettings, {
                target: document.body,
                props: { host, onClose: close },
            })
            await settle()
            searchFor(label)
            await settle()
            expectControl(defaultValue)
            expect(row().textContent).not.toContain("Modified")
            await unmount(component)
            await host.dispose()
            host = await synthetic(storage, [other])
            component = mount(GlobalSettings, {
                target: document.body,
                props: { host, onClose: close },
            })
            await settle()
            searchFor(label)
            await settle()
            expectControl(defaultValue)
            expect(row().textContent).not.toContain("Modified")
            expect(await host.settings.getValue(`test.options.${id}`)).toBe(defaultValue)
            expect(await host.settings.getValue(unrelatedId)).toBe(unrelatedValue)
            expect(await host.settings.getValue("test.other.caption")).toBe("keep other plugin")
            expect(await host.settings.getValue("settings.theme")).toBe("dark")
        } finally {
            await unmount(component)
            await host.dispose()
        }
    },
)

it("keeps a failed search edit and its error through query clearing and a category roundtrip", async () => {
    const storage = new MemoryStorageBackend()
    const host = await synthetic(storage)
    const component = mount(GlobalSettings, {
        target: document.body,
        props: { host, onClose() {} },
    })
    const set = storage.set.bind(storage)
    try {
        await settle()
        searchFor("Caption")
        await settle()
        storage.set = async (key, value) => {
            if (key.endsWith(":test.options.text")) throw new Error("private save error")
            await set(key, value)
        }
        input("<b>Caption</b>", "retained attempt")
        await settle()
        expect(document.querySelector("article")?.textContent).toContain("Not saved")
        expect(document.querySelector("article")?.textContent).not.toContain("Modified")
        expect(await host.settings.getValue("test.options.text")).toBe("saved")
        searchFor("Count")
        await settle()
        expect(document.body.textContent).not.toContain("Not saved")
        button("Clear search").click()
        await settle()
        button("Reading").click()
        await settle()
        button("Plugins").click()
        await settle()
        button("Paper Tools").click()
        await settle()
        expect(field("<b>Caption</b>").value).toBe("retained attempt")
        expect(field("<b>Caption</b>").closest("article")?.textContent).toContain("Not saved")
        searchFor("description")
        await settle()
        expect(document.querySelectorAll("article")).toHaveLength(1)
        expect(field("<b>Caption</b>").value).toBe("retained attempt")
        expect(document.querySelector("article")?.textContent).toContain("Not saved")
        expect(document.querySelector("article")?.textContent).not.toContain("Modified")
        storage.set = set
        button("Retry").click()
        await settle()
        expect(await host.settings.getValue("test.options.text")).toBe("retained attempt")
        expect(document.querySelector("article")?.textContent).not.toContain("Not saved")
        expect(document.querySelector("article")?.textContent).toContain("Modified")
    } finally {
        storage.set = set
        await unmount(component)
        await host.dispose()
    }
})

it("searches localized names and descriptions and distinguishes identical labels by category and plugin without duplicates", async () => {
    const localized = plugin(
        (context) => {
            context.settings.register({
                id: "test.colors.theme",
                label: () => m.theme(),
                description: () => (getLocale() === "ru" ? "Контраст чернил" : "Ink contrast"),
                defaultValue: "ink",
                editor: { kind: "text" },
                category: "appearance",
            })
        },
        "test.colors",
        "Color Tools",
    )
    const similar = plugin(
        (context) => {
            context.settings.register({
                id: "test.palette.theme",
                label: () => m.theme(),
                defaultValue: false,
                editor: { kind: "boolean" },
            })
        },
        "test.palette",
        "Palette Tools",
    )
    const host = await synthetic(new MemoryStorageBackend(), [localized, similar])
    const component = mount(GlobalSettings, {
        target: document.body,
        props: { host, onClose() {} },
    })
    try {
        await settle()
        expect(button("Plugins").getAttribute("aria-expanded")).toBe("false")
        searchFor("theme")
        await settle()
        const rows = [...document.querySelectorAll("article")]
        expect(rows).toHaveLength(3)
        expect(rows.map((row) => row.getAttribute("aria-label"))).toEqual([
            "Theme",
            "Theme",
            "Theme",
        ])
        expect(rows.filter((row) => row.textContent?.includes("Appearance"))).toHaveLength(1)
        expect(rows.filter((row) => row.textContent?.includes("› Color Tools"))).toHaveLength(1)
        expect(rows.filter((row) => row.textContent?.includes("› Palette Tools"))).toHaveLength(1)
        searchFor("ink contrast")
        await settle()
        expect(document.querySelectorAll("article")).toHaveLength(1)
        expect(field("Theme").value).toBe("ink")
        searchFor("Palette Tools")
        await settle()
        expect(document.querySelectorAll("article")).toHaveLength(1)
        expect(field("Theme").type).toBe("checkbox")
        window.history.replaceState({}, "", "/")
        setLocale("ru", { reload: false })
        searchFor("Контраст чернил")
        await settle()
        expect(document.querySelectorAll("article")).toHaveLength(1)
        expect(field("Тема").value).toBe("ink")
        searchFor("Тема")
        await settle()
        const translated = [...document.querySelectorAll("article")]
        expect(translated).toHaveLength(3)
        expect(translated.every((row) => row.getAttribute("aria-label") === "Тема")).toBe(true)
        expect(
            translated.filter((row) => row.textContent?.includes(m.settings_appearance())),
        ).toHaveLength(1)
        expect(translated.filter((row) => row.textContent?.includes("› Color Tools"))).toHaveLength(
            1,
        )
        searchFor("ink contrast")
        await settle()
        expect(document.querySelectorAll("article")).toHaveLength(0)
        expect(document.body.textContent).toContain(m.settings_no_results())
    } finally {
        setLocale("en", { reload: false })
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

it("refreshes an open plugin tree for late registration and disposal without discovering failed activations", async () => {
    let context!: ExtensionContext
    let failedActivations = 0
    const late = plugin(
        (value) => {
            context = value
        },
        "test.late",
        "Late Tools",
    )
    const failed = plugin(
        (value) => {
            failedActivations++
            value.settings.register({
                id: "test.failed.option",
                label: "Failed option",
                defaultValue: true,
                editor: { kind: "boolean" },
            })
            throw new Error("activation failed")
        },
        "test.failed",
        "Failed Tools",
        [],
    )
    const host = await synthetic(new MemoryStorageBackend(), [late, failed])
    const component = mount(GlobalSettings, {
        target: document.body,
        props: { host, onClose() {} },
    })
    try {
        await settle()
        button("Plugins").click()
        await settle()
        expect(button("Late Tools")).toBeUndefined()
        expect(button("Failed Tools")).toBeUndefined()
        searchFor("Late option")
        await settle()
        expect(document.body.textContent).toContain("No matching settings")
        expect(failedActivations).toBe(0)
        const registration = context.settings.register({
            id: "test.late.option",
            label: "Late option",
            defaultValue: "initial",
            editor: { kind: "text" },
        })
        await settle()
        expect(field("Late option").value).toBe("initial")
        button("Clear search").click()
        await settle()
        button("Late Tools").click()
        await settle()
        input("Late option", "durable late value")
        await settle()
        await expect(host.activate("test.failed")).rejects.toThrow("Failed to activate extension")
        await settle()
        expect(failedActivations).toBe(1)
        expect(field("Late option").value).toBe("durable late value")
        expect(button("Failed Tools")).toBeUndefined()
        registration.dispose()
        await settle()
        expect(document.querySelector("article input")).toBeNull()
        expect(button("Late Tools")).toBeUndefined()
        expect(document.querySelector('section[aria-label="Plugins"]')).not.toBeNull()
        searchFor("Failed option")
        await settle()
        expect(document.body.textContent).toContain("No matching settings")
        searchFor("Late option")
        await settle()
        expect(document.body.textContent).toContain("No matching settings")
    } finally {
        await unmount(component)
        await host.dispose()
    }
})

it("removes a focused failed search contribution, fences its captured Retry and restores saved values on reactivation", async () => {
    const storage = new MemoryStorageBackend()
    let context!: ExtensionContext
    let activations = 0
    const definition = {
        id: "test.live.caption",
        label: "Live caption",
        defaultValue: "original",
        editor: { kind: "text" },
    } as const
    const live = plugin(
        (value) => {
            context = value
            if (activations++ > 0) value.settings.register(definition)
        },
        "test.live",
        "Live Tools",
    )
    const host = await synthetic(storage, [live])
    const component = mount(GlobalSettings, {
        target: document.body,
        props: { host, onClose() {} },
    })
    const set = storage.set.bind(storage)
    try {
        const registration = context.settings.register(definition)
        await settle()
        searchFor("Live caption")
        await settle()
        input("Live caption", "last saved caption")
        await settle()
        expect(await host.settings.getValue("test.live.caption")).toBe("last saved caption")
        storage.set = async (key, value) => {
            if (key.endsWith(":test.live.caption")) throw new Error("private save failure")
            await set(key, value)
        }
        input("Live caption", "failed old contribution")
        await settle()
        expect(document.querySelector("article")?.textContent).toContain("Not saved")
        const capturedRetry = button("Retry")
        const removedControl = field("Live caption")
        removedControl.focus()
        expect(document.activeElement).toBe(removedControl)
        registration.dispose()
        await settle()
        expect(removedControl.isConnected).toBe(false)
        expect(document.querySelector("article input")).toBeNull()
        expect(document.body.textContent).toContain("No matching settings")
        expect(document.body.textContent).toContain("unsaved edits were discarded")
        storage.set = set
        context.settings.register(definition)
        await settle()
        expect(field("Live caption").value).toBe("last saved caption")
        expect(document.body.textContent).not.toContain("Not saved")
        capturedRetry.click()
        await settle()
        expect(await host.settings.getValue("test.live.caption")).toBe("last saved caption")
        expect(field("Live caption").value).toBe("last saved caption")
        await host.disable("test.live")
        await settle()
        expect(document.body.textContent).toContain("No matching settings")
        await host.enable("test.live")
        await settle()
        expect(document.body.textContent).toContain("No matching settings")
        expect(activations).toBe(1)
        await host.activate("test.live")
        await settle()
        expect(activations).toBe(2)
        expect(field("Live caption").value).toBe("last saved caption")
        expect(document.querySelector("article")?.textContent).toContain("Modified")
        input("Live caption", "fresh contribution")
        await settle()
        expect(await host.settings.getValue("test.live.caption")).toBe("fresh contribution")
    } finally {
        storage.set = set
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
        await unmount(component)
        await host.dispose()
        host = await synthetic(storage)
        component = mount(GlobalSettings, { target: document.body, props: { host, onClose() {} } })
        await settle()
        searchFor("Count")
        await settle()
        expect(field("Count").value).toBe("2")
        expect(document.querySelector("article")?.textContent).not.toContain("Modified")
    } finally {
        storage.set = set
        await unmount(component)
        await host.dispose()
    }
})

it("guards a held failed reset and retains its draft through clearing search and category roundtrips until Retry", async () => {
    const storage = new MemoryStorageBackend()
    const host = await synthetic(storage)
    await host.settings.setValue("test.options.number", 8)
    await host.settings.setValue("test.options.text", "leave caption alone")
    const close = vi.fn()
    const component = mount(GlobalSettings, {
        target: document.body,
        props: { host, onClose: close },
    })
    const set = storage.set.bind(storage)
    let release!: () => void
    const changes: unknown[] = []
    const subscription = host.settings.onDidChange((change) => {
        if (change.kind === "value" && change.settingId === "test.options.number")
            changes.push(change.value)
    })
    try {
        await settle()
        searchFor("Count")
        await settle()
        storage.set = async (key, value) => {
            if (key.endsWith(":test.options.number")) {
                await new Promise<void>((resolve) => {
                    release = resolve
                })
                throw new Error("private reset failure")
            }
            await set(key, value)
        }
        button("Reset to default").click()
        await settle()
        expect(field("Count").value).toBe("2")
        expect(document.querySelector("article")?.textContent).toContain("Saving")
        expect(document.querySelector("article")?.textContent).toContain("Modified")
        // Catalog reads join the held per-setting queue; observe ACKs until it settles.
        expect(changes).toEqual([])
        const closing = component.requestClose()
        await settle()
        expect(close).not.toHaveBeenCalled()
        expect(document.querySelector('[role="alertdialog"]')).toBeNull()
        expect(field("Count").matches(":disabled")).toBe(true)
        release()
        await closing
        await settle()
        expect(document.querySelector('[role="alertdialog"]')).not.toBeNull()
        expect(close).not.toHaveBeenCalled()
        button("Stay").click()
        await settle()
        expect(field("Count").value).toBe("2")
        expect(document.querySelector("article")?.textContent).toContain("Not saved")
        expect(document.querySelector("article")?.textContent).toContain("Modified")
        expect(await host.settings.getValue("test.options.number")).toBe(8)
        expect(changes).toEqual([])
        searchFor("no reset matches")
        await settle()
        expect(document.body.textContent).toContain("No matching settings")
        button("Clear search").click()
        await settle()
        button("Appearance").click()
        await settle()
        button("Plugins").click()
        await settle()
        button("Paper Tools").click()
        await settle()
        expect(field("Count").value).toBe("2")
        const row = field("Count").closest("article")!
        expect(row.textContent).toContain("Not saved")
        expect(row.textContent).toContain("Modified")
        expect(field("Count").getAttribute("aria-invalid")).toBe("true")
        const descriptions = field("Count").getAttribute("aria-describedby")!.split(" ")
        expect(
            descriptions.some((id) =>
                document.getElementById(id)?.textContent?.includes("Not saved"),
            ),
        ).toBe(true)
        storage.set = set
        ;[...row.querySelectorAll("button")].find((node) => node.textContent === "Retry")!.click()
        await settle()
        expect(await host.settings.getValue("test.options.number")).toBe(2)
        expect(changes).toEqual([2])
        expect(row.textContent).not.toContain("Not saved")
        expect(row.textContent).not.toContain("Modified")
        expect(await host.settings.getValue("test.options.text")).toBe("leave caption alone")
        await component.requestClose()
        expect(close).toHaveBeenCalledOnce()
    } finally {
        storage.set = set
        release?.()
        subscription.dispose()
        await unmount(component)
        await host.dispose()
    }
})

it("orders a held successful reset before a newer edit and waits for both before closing", async () => {
    const storage = new MemoryStorageBackend()
    const host = await synthetic(storage)
    await host.settings.setValue("test.options.number", 8)
    const close = vi.fn()
    const component = mount(GlobalSettings, {
        target: document.body,
        props: { host, onClose: close },
    })
    const set = storage.set.bind(storage)
    let release!: () => void
    const changes: unknown[] = []
    const subscription = host.settings.onDidChange((change) => {
        if (change.kind === "value" && change.settingId === "test.options.number")
            changes.push(change.value)
    })
    try {
        await settle()
        searchFor("Count")
        await settle()
        storage.set = async (key, value) => {
            if (key.endsWith(":test.options.number") && value === 2) {
                await new Promise<void>((resolve) => {
                    release = resolve
                })
            }
            await set(key, value)
        }
        button("Reset to default").click()
        await settle()
        expect(document.querySelector("article")?.textContent).toContain("Saving")
        expect(document.querySelector("article")?.textContent).toContain("Modified")
        input("Count", "6")
        await settle()
        expect(field("Count").value).toBe("6")
        expect(changes).toEqual([])
        const closing = component.requestClose()
        await settle()
        expect(close).not.toHaveBeenCalled()
        expect(document.querySelector('[role="alertdialog"]')).toBeNull()
        release()
        await closing
        await settle()
        expect(changes).toEqual([2, 6])
        expect(field("Count").value).toBe("6")
        expect(document.querySelector("article")?.textContent).toContain("Modified")
        expect(document.querySelector("article")?.textContent).not.toContain("Saving")
        expect(await host.settings.getValue("test.options.number")).toBe(6)
        expect(close).toHaveBeenCalledOnce()
        expect(document.querySelector('[role="alertdialog"]')).toBeNull()
    } finally {
        storage.set = set
        release?.()
        subscription.dispose()
        await unmount(component)
        await host.dispose()
    }
})

it("retains a newer invalid draft after a held successful reset and discards only that unsaved attempt", async () => {
    const storage = new MemoryStorageBackend()
    const host = await synthetic(storage)
    await host.settings.setValue("test.options.number", 8)
    const close = vi.fn()
    const component = mount(GlobalSettings, {
        target: document.body,
        props: { host, onClose: close },
    })
    const set = storage.set.bind(storage)
    let release!: () => void
    try {
        await settle()
        searchFor("Count")
        await settle()
        storage.set = async (key, value) => {
            if (key.endsWith(":test.options.number")) {
                await new Promise<void>((resolve) => {
                    release = resolve
                })
            }
            await set(key, value)
        }
        button("Reset to default").click()
        await settle()
        input("Count", "3", false)
        await settle()
        expect(field("Count").getAttribute("aria-invalid")).toBe("true")
        expect(document.querySelector("article")?.textContent).toContain("Modified")
        const closing = component.requestClose()
        await settle()
        expect(close).not.toHaveBeenCalled()
        expect(document.querySelector('[role="alertdialog"]')).toBeNull()
        release()
        await closing
        await settle()
        expect(document.querySelector('[role="alertdialog"]')).not.toBeNull()
        expect(field("Count").value).toBe("3")
        expect(field("Count").getAttribute("aria-invalid")).toBe("true")
        expect(await host.settings.getValue("test.options.number")).toBe(2)
        expect(document.querySelector("article")?.textContent).not.toContain("Modified")
        button("Stay").click()
        await settle()
        expect(field("Count").value).toBe("3")
        expect(close).not.toHaveBeenCalled()
        await component.requestClose()
        await settle()
        button("Discard unsaved edits").click()
        await settle()
        expect(close).toHaveBeenCalledOnce()
        expect(await host.settings.getValue("test.options.number")).toBe(2)
    } finally {
        storage.set = set
        release?.()
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
