// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { flushSync, mount, tick, unmount } from "svelte"
import { COMMANDS_CONTEXT_KEY, commandsStore } from "$lib/core/commands"
import { modalManager } from "$lib/shared/ui/modal/modalManager.svelte"
import NoteEditor from "./NoteEditor.svelte"

vi.mock("$lib/shared/state/viewport.svelte", () => ({ viewport: { isCompact: false } }))
vi.mock("$lib/shared/state/motion.svelte", () => ({ motionPreferences: { enabled: false } }))

const originalAnimate = Element.prototype.animate

beforeEach(() => {
    vi.useFakeTimers()
    // jsdom does not implement the Web Animations API used by Svelte transitions.
    Element.prototype.animate = vi.fn(() => ({
        cancel: () => undefined,
        pause: () => undefined,
        play: () => undefined,
        finished: Promise.resolve(),
        effect: { getComputedTiming: () => ({ progress: 1 }) },
    })) as unknown as typeof Element.prototype.animate
    vi.stubGlobal("requestAnimationFrame", () => 1)
    vi.stubGlobal("cancelAnimationFrame", () => undefined)
})

afterEach(async () => {
    try {
        modalManager.reset()
        // Unmount/click/focus can defer tooltip hiding by one frame; own that work in jsdom.
        await vi.runOnlyPendingTimersAsync()
        expect(vi.getTimerCount()).toBe(0)
    } finally {
        document.body.replaceChildren()
        Element.prototype.animate = originalAnimate
        vi.unstubAllGlobals()
        vi.useRealTimers()
    }
})

describe("modeless note editor keyboard routing", () => {
    it("returns shortcuts to the sidebar when focus or pointer leaves the editor", async () => {
        const sidebarScope = commandsStore.createScope(commandsStore.root)
        const sidebarAction = vi.fn()
        const unregister = commandsStore.register(sidebarScope, [
            {
                id: "viewer.note.edit",
                label: () => "Edit note",
                category: "commands",
                keymap: "ctrl+j",
                allowInInputs: true,
                run: sidebarAction,
            },
        ])
        commandsStore.activate(sidebarScope)
        const target = document.createElement("div")
        const opener = document.createElement("button")
        const sidebarSearch = document.createElement("input")
        document.body.append(opener, target, sidebarSearch)
        opener.focus()
        const save = vi.fn()
        const editor = mount(NoteEditor, {
            target,
            context: new Map([[COMMANDS_CONTEXT_KEY, sidebarScope]]),
            props: {
                editorId: "draft-a",
                editorState: {
                    pageNumber: 1,
                    text: "Passage",
                    noteContent: "Draft",
                    color: "yellow",
                },
                saving: false,
                onActivate: () => undefined,
                onChange: () => undefined,
                onSave: save,
                onCancel: () => undefined,
            },
        })
        flushSync()
        await tick()
        modalManager.setModeless("draft-a")
        flushSync()
        const textarea = document.querySelector("textarea")!
        const key = (element: HTMLElement, value: string) => {
            const event = new KeyboardEvent("keydown", { key: value, ctrlKey: true, bubbles: true })
            element.dispatchEvent(event)
            return commandsStore.handleKeydown(event)
        }

        try {
            textarea.focus()
            await key(textarea, "Enter")
            expect(save).toHaveBeenCalledOnce()

            sidebarSearch.focus()
            expect(commandsStore.activeScope).toBe(sidebarScope)
            await key(sidebarSearch, "Enter")
            await key(sidebarSearch, "j")
            expect(save).toHaveBeenCalledOnce()
            expect(sidebarAction).toHaveBeenCalledOnce()

            textarea.focus()
            sidebarSearch.dispatchEvent(new Event("pointerdown", { bubbles: true }))
            expect(commandsStore.activeScope).toBe(sidebarScope)
        } finally {
            sidebarSearch.focus()
            await unmount(editor)
            expect(document.activeElement).toBe(sidebarSearch)
            unregister()
            sidebarScope.destroy()
        }
    })
    it("announces a safe persistence failure while keeping annotation input available", async () => {
        const target = document.createElement("div")
        document.body.append(target)
        const editor = mount(NoteEditor, {
            target,
            props: {
                editorId: "failed-note",
                editorState: {
                    pageNumber: 1,
                    text: "<img src=x onerror=alert(1)>",
                    noteContent: "Kept",
                    color: "blue",
                },
                saving: false,
                failed: true,
                onActivate() {},
                onChange() {},
                onSave() {},
                onCancel() {},
            },
        })
        try {
            flushSync()
            await tick()
            expect(document.querySelector('[role="alert"]')?.textContent).toMatch(
                /Unable to save|Не удалось сохранить/,
            )
            expect(document.querySelector("textarea")?.value).toBe("Kept")
            expect(document.querySelector("textarea")?.disabled).toBe(false)
            expect(document.querySelector("img")).toBeNull()
        } finally {
            await unmount(editor)
        }
    })
})

it("offers explicit discard separately from hiding a recovered draft", async () => {
    const target = document.createElement("div")
    document.body.append(target)
    const hide = vi.fn(),
        discard = vi.fn(),
        save = vi.fn()
    const editor = mount(NoteEditor, {
        target,
        props: {
            editorId: "recovered",
            editorState: {
                id: "stable-draft",
                pageNumber: 2,
                text: "<script>unsafe()</script>",
                noteContent: "Recovered",
                color: "purple",
            },
            draft: true,
            saving: false,
            onActivate() {},
            onChange() {},
            onSave: save,
            onCancel: hide,
            onDiscard: discard,
        },
    })
    try {
        flushSync()
        await tick()
        const button = [...document.querySelectorAll("button")].find((button) =>
            /Discard draft|Удалить черновик/.test(button.textContent ?? ""),
        )!
        expect(button).toBeDefined()
        button.click()
        expect(discard).toHaveBeenCalledOnce()
        expect(hide).not.toHaveBeenCalled()
        document.querySelector<HTMLButtonElement>("#recovered-close")!.click()
        await tick()
        expect(hide).toHaveBeenCalledOnce()
        expect(save).not.toHaveBeenCalled()
        expect(document.querySelector("script")).toBeNull()
    } finally {
        await unmount(editor)
    }
})
