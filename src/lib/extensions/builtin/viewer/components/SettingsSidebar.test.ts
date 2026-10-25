// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { flushSync, mount, unmount } from "svelte"
import { fromStore, writable } from "svelte/store"
import { commandsStore, type CommandScope } from "$lib/core/commands"
import * as m from "$lib/paraglide/messages"
import type { SettingsLayout } from "$lib/extension-api"
import { getViewerRuntimeContext, type ViewerRuntime } from "../viewerRuntime"
import SettingsSidebar from "./SettingsSidebar.svelte"
import sidebarSource from "./SettingsSidebar.svelte?raw"

const viewport = vi.hoisted(() => ({ isCompact: false, isShortHeight: false }))
vi.mock("$lib/shared/state/viewport.svelte", () => ({ viewport }))
vi.mock("../viewerRuntime", () => ({ getViewerRuntimeContext: vi.fn() }))

let component: ReturnType<typeof mount> | undefined
let scope: CommandScope
const executeCommand = vi.fn(async (_id: string, _payload?: unknown) => undefined)

function setup(withSettings = true) {
    const documentState = writable({ scale: 1.75, layout: "split" as SettingsLayout })
    const document = fromStore(documentState)
    const preferences = writable({ quality: 3, animations: true })
    const global = fromStore(preferences)
    const runtime = {
        store: {
            get scale() {
                return document.current.scale
            },
            get layout() {
                return document.current.layout
            },
        },
        executeCommand,
        settings: withSettings
            ? {
                  CONSTANTS: { minQuality: 1, maxQuality: 5 },
                  settingsStore: {
                      // Global defaults deliberately differ from the active document.
                      scale: 4,
                      layout: "single",
                      get quality() {
                          return global.current.quality
                      },
                      get animations() {
                          return global.current.animations
                      },
                  },
              }
            : undefined,
    } as unknown as ViewerRuntime
    vi.mocked(getViewerRuntimeContext).mockReturnValue(() => runtime)
    const target = window.document.createElement("div")
    window.document.body.append(target)
    component = mount(SettingsSidebar, { target })
    flushSync()
    return { documentState, preferences }
}

function button(label: string) {
    const result = [...document.querySelectorAll("button")].find(
        (node) => node.getAttribute("aria-label") === label || node.textContent?.trim() === label,
    )
    expect(result, `Button: ${label}`).toBeDefined()
    return result!
}

function input(type: "number" | "range" | "checkbox") {
    return document.querySelector<HTMLInputElement>(`input[type="${type}"]`)!
}

beforeEach(() => {
    executeCommand.mockClear()
    viewport.isCompact = false
    viewport.isShortHeight = false
    scope = commandsStore.createScope(commandsStore.root)
    commandsStore.activate(scope)
})

afterEach(async () => {
    if (component) await unmount(component)
    component = undefined
    scope.destroy()
    document.body.replaceChildren()
})

describe("SettingsSidebar reading controls", () => {
    it.each([
        [false, false],
        [false, true],
        [true, false],
        [true, true],
    ])("exposes every reading control at compact=%s, short=%s", (isCompact, isShortHeight) => {
        Object.assign(viewport, { isCompact, isShortHeight })
        setup()

        for (const label of [
            m.single_page(),
            m.split_pages(),
            m.scroll_pages(),
            m.zoom_out(),
            m.zoom_in(),
            m.keymap_zoom_to_fit(),
            m.settings_open(),
        ]) {
            expect(button(label).hidden).toBe(false)
        }
        expect(input("number").getAttribute("aria-label")).toBe(m.zoom_scale())
        expect(input("range").getAttribute("aria-label")).toBe(m.zoom_slider_aria())
        const quality = document.querySelector("select")!
        expect(quality.labels?.[0].textContent).toBe(m.quality())
        expect([...quality.options].map(({ value }) => value)).toEqual(["1", "2", "3", "4", "5"])
        expect(input("checkbox").labels?.[0].textContent).toContain(m.animations())
        for (const control of [quality, input("checkbox")]) {
            const description = document.getElementById(control.getAttribute("aria-describedby")!)
            expect(description?.textContent?.trim()).toBeTruthy()
        }
        expect(document.querySelectorAll("select")).toHaveLength(1)
        expect(document.querySelectorAll('input[type="checkbox"]')).toHaveLength(1)
        expect(executeCommand).not.toHaveBeenCalled()
    })

    it("reads active-document layout/zoom and follows document changes, not global defaults", () => {
        const { documentState } = setup()
        expect(input("number").value).toBe("175")
        expect(input("range").value).toBe("175")
        expect(button(m.split_pages()).getAttribute("aria-pressed")).toBe("true")
        expect(button(m.single_page()).getAttribute("aria-pressed")).toBe("false")

        flushSync(() => documentState.set({ scale: 2.25, layout: "scroll" }))
        expect(input("number").value).toBe("225")
        expect(input("range").value).toBe("225")
        expect(button(m.scroll_pages()).getAttribute("aria-pressed")).toBe("true")
        expect(button(m.split_pages()).getAttribute("aria-pressed")).toBe("false")
        expect(executeCommand).not.toHaveBeenCalled()
    })

    it("routes layout and step zoom through the owning runtime", () => {
        setup()
        button(m.single_page()).click()
        button(m.split_pages()).click()
        button(m.scroll_pages()).click()
        button(m.zoom_out()).click()
        button(m.zoom_in()).click()
        expect(executeCommand.mock.calls).toEqual([
            ["settings.layout", { value: "single" }],
            ["settings.layout", { value: "split" }],
            ["settings.layout", { value: "scroll" }],
            ["settings.zoom.out"],
            ["settings.zoom.in"],
        ])
        // The host adapter, not the panel, owns persistence and document updates.
        expect(input("number").value).toBe("175")
        expect(button(m.split_pages()).getAttribute("aria-pressed")).toBe("true")
    })

    it.each([
        ["240", 2.4, "240"],
        ["999", 5, "500"],
        ["1", 0.25, "25"],
    ])("commits/clamps numeric zoom %s", (value, scale, display) => {
        setup()
        input("number").value = value
        input("number").dispatchEvent(new Event("change", { bubbles: true }))
        expect(executeCommand).toHaveBeenCalledExactlyOnceWith("settings.zoom.in", { value: scale })
        expect(input("number").value).toBe(display)
    })

    it("restores empty zoom and blurs on Enter", () => {
        setup()
        const zoom = input("number")
        zoom.value = ""
        zoom.dispatchEvent(new Event("change", { bubbles: true }))
        expect(zoom.value).toBe("175")
        expect(executeCommand).not.toHaveBeenCalled()
        zoom.focus()
        zoom.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }))
        expect(document.activeElement).not.toBe(zoom)
    })

    it("routes slider input through the document-aware zoom command", () => {
        setup()
        input("range").value = "85"
        input("range").dispatchEvent(new Event("input", { bubbles: true }))
        expect(executeCommand).toHaveBeenCalledExactlyOnceWith("settings.zoom.in", { value: 0.85 })
    })

    it("edits host-owned quality and animations via commands and follows external updates", () => {
        const { preferences } = setup()
        const quality = document.querySelector("select")!
        expect(quality.value).toBe("3")
        expect(input("checkbox").checked).toBe(true)
        quality.value = "5"
        quality.dispatchEvent(new Event("change", { bubbles: true }))
        input("checkbox").click()
        expect(executeCommand.mock.calls).toEqual([
            ["settings.quality.in", { value: 5 }],
            ["settings.animations.toggle"],
        ])

        flushSync(() => preferences.set({ quality: 2, animations: false }))
        expect(quality.value).toBe("2")
        expect(input("checkbox").checked).toBe(false)
        flushSync(() => preferences.set({ quality: 4, animations: true }))
        expect(quality.value).toBe("4")
        expect(input("checkbox").checked).toBe(true)
        expect(executeCommand).toHaveBeenCalledTimes(2)
    })

    it("dispatches fit-width in the local scope, never to the host registry", async () => {
        const fit = vi.fn()
        scope.registerAll([
            {
                id: "viewer.zoom.fit-width",
                label: m.keymap_zoom_to_fit,
                category: "settings",
                run: fit,
            },
        ])
        // A settings sidebar can be the active child of the canvas command scope.
        const sidebarScope = commandsStore.createScope(scope)
        commandsStore.activate(sidebarScope)
        try {
            setup()
            expect(button(m.keymap_zoom_to_fit()).disabled).toBe(false)
            button(m.keymap_zoom_to_fit()).click()
            await Promise.resolve()
            expect(fit).toHaveBeenCalledOnce()
            expect(executeCommand).not.toHaveBeenCalled()
        } finally {
            sidebarScope.destroy()
        }
    })

    it("disables fit-width when unavailable and tracks scoped registration/removal", () => {
        setup()
        const fitButton = button(m.keymap_zoom_to_fit())
        expect(fitButton.disabled).toBe(true)
        fitButton.click()
        expect(executeCommand).not.toHaveBeenCalled()
        const fit = vi.fn()
        const unregister = scope.registerAll([
            {
                id: "viewer.zoom.fit-width",
                label: m.keymap_zoom_to_fit,
                category: "settings",
                run: fit,
            },
        ])
        flushSync()
        expect(fitButton.disabled).toBe(false)
        unregister()
        flushSync()
        expect(fitButton.disabled).toBe(true)
        fitButton.click()
        expect(fit).not.toHaveBeenCalled()
    })

    it("keeps Open Settings last and uses the host-owned settings.open command", () => {
        setup()
        const buttons = [...document.querySelectorAll("button")]
        const open = button(m.settings_open())
        expect(buttons.at(-1)).toBe(open)
        expect(open.closest(".sidebar-content")?.lastElementChild).toBe(open.parentElement)
        open.click()
        expect(executeCommand).toHaveBeenCalledExactlyOnceWith("settings.open")
    })

    it("does not borrow singleton settings if the runtime has no settings capability", () => {
        setup(false)
        expect(document.querySelector("select")).toBeNull()
        expect(document.querySelector('input[type="checkbox"]')).toBeNull()
        expect(input("number").value).toBe("175")
        button(m.settings_open()).click()
        expect(executeCommand).toHaveBeenCalledExactlyOnceWith("settings.open")
    })

    it("owns a nonshrinking, independently scrollable tool list including its safe-area CTA", () => {
        const content = sidebarSource.match(/\.sidebar-content \{([^}]+)\}/)?.[1]
        expect(content).toMatch(/min-height:\s*0;/)
        expect(content).toMatch(/overflow-y:\s*auto;/)
        expect(content).toContain("--sidebar-safe-area-end")
        expect(sidebarSource.match(/\.settings-section \{([^}]+)\}/)?.[1]).toMatch(/flex:\s*none;/)
        expect(sidebarSource.match(/\.settings-footer \{([^}]+)\}/)?.[1]).toMatch(/flex:\s*none;/)
        expect(sidebarSource).not.toMatch(/@media[^}]*display:\s*none/s)
    })
})
