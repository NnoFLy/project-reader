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

afterEach(() => {
    modalManager.reset()
    document.body.replaceChildren()
    Element.prototype.animate = originalAnimate
    vi.unstubAllGlobals()
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
})
