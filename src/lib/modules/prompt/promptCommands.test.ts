import { describe, expect, it, vi } from "vitest"
import { CommandsStore } from "$lib/modules/commands"
import { defineCommands } from "$lib/modules/commands"
import { createPromptCommands, type PromptCommandActions } from "./promptCommands"

type EventModifiers = Pick<KeyboardEvent, "altKey" | "ctrlKey" | "metaKey" | "shiftKey">

function createKeyboardEvent(
    key: string,
    code: string,
    modifiers: Partial<EventModifiers> = {},
): KeyboardEvent {
    return {
        key,
        code,
        altKey: false,
        ctrlKey: false,
        metaKey: false,
        shiftKey: false,
        target: { tagName: "INPUT", isContentEditable: false },
        preventDefault: vi.fn(),
        ...modifiers,
    } as unknown as KeyboardEvent
}

function setup(canNavigateBack = true) {
    const actions: PromptCommandActions = {
        close: vi.fn(),
        next: vi.fn(),
        previous: vi.fn(),
        select: vi.fn(),
        navigateBack: vi.fn(),
        canNavigateBack: vi.fn(() => canNavigateBack),
        historyBack: vi.fn(),
        historyForward: vi.fn(),
    }
    const store = new CommandsStore()
    const scope = store.createScope(store.root, { keyboardBoundary: true })
    scope.registerAll(Object.values(createPromptCommands(actions)))
    return { actions, scope, store }
}

describe("prompt commands", () => {
    it.each<[string, KeyboardEvent, keyof PromptCommandActions]>([
        ["ArrowDown", createKeyboardEvent("ArrowDown", "ArrowDown"), "next"],
        ["Ctrl+N", createKeyboardEvent("n", "KeyN", { ctrlKey: true }), "next"],
        ["Ctrl+J", createKeyboardEvent("j", "KeyJ", { ctrlKey: true }), "next"],
        ["ArrowUp", createKeyboardEvent("ArrowUp", "ArrowUp"), "previous"],
        ["Ctrl+P", createKeyboardEvent("p", "KeyP", { ctrlKey: true }), "previous"],
        ["Ctrl+K", createKeyboardEvent("k", "KeyK", { ctrlKey: true }), "previous"],
        ["Escape", createKeyboardEvent("Escape", "Escape"), "close"],
        ["Ctrl+[", createKeyboardEvent("[", "BracketLeft", { ctrlKey: true }), "close"],
        ["Ctrl+C", createKeyboardEvent("c", "KeyC", { ctrlKey: true }), "close"],
        ["Ctrl+G", createKeyboardEvent("g", "KeyG", { ctrlKey: true }), "close"],
        ["Enter", createKeyboardEvent("Enter", "Enter"), "select"],
        ["Backspace", createKeyboardEvent("Backspace", "Backspace"), "navigateBack"],
        ["Alt+P", createKeyboardEvent("p", "KeyP", { altKey: true }), "historyBack"],
        ["Alt+N", createKeyboardEvent("n", "KeyN", { altKey: true }), "historyForward"],
    ])("invokes the correct action for %s", async (_binding, event, action) => {
        const { actions, scope, store } = setup()

        await store.handleKeydown(event, scope)

        expect(actions[action]).toHaveBeenCalledOnce()
        expect(event.preventDefault).toHaveBeenCalledOnce()
    })

    it.each(["j", "k", "n", "p"])("leaves bare %s available for query input", async (key) => {
        const { actions, scope, store } = setup()
        const event = createKeyboardEvent(key, `Key${key.toUpperCase()}`)

        await store.handleKeydown(event, scope)

        expect(Object.values(actions).every((action) => !vi.mocked(action).mock.calls.length)).toBe(
            true,
        )
        expect(event.preventDefault).not.toHaveBeenCalled()
    })

    it("leaves Backspace to the input when prompt-back is unavailable", async () => {
        const { actions, scope, store } = setup(false)
        const event = createKeyboardEvent("Backspace", "Backspace")

        await store.handleKeydown(event, scope)

        expect(actions.navigateBack).not.toHaveBeenCalled()
        expect(event.preventDefault).not.toHaveBeenCalled()
    })

    it.each([
        createKeyboardEvent("j", "KeyJ", { altKey: true }),
        createKeyboardEvent("n", "KeyN", { metaKey: true }),
        createKeyboardEvent("k", "KeyK", { ctrlKey: true, shiftKey: true }),
    ])("ignores unrelated modifier combinations", async (event) => {
        const { actions, scope, store } = setup()

        await store.handleKeydown(event, scope)

        expect(Object.values(actions).every((action) => !vi.mocked(action).mock.calls.length)).toBe(
            true,
        )
        expect(event.preventDefault).not.toHaveBeenCalled()
    })

    it("keeps every prompt command out of the palette", () => {
        const { scope } = setup()
        expect(scope.listPaletteCommands()).toEqual([])
    })

    it("closes on the first Escape press while the query input is focused", async () => {
        const { actions, scope, store } = setup()
        const event = createKeyboardEvent("Escape", "Escape")

        await store.handleKeydown(event, scope)

        expect(actions.close).toHaveBeenCalledOnce()
        expect(createPromptCommands(actions)["prompt.close"]).not.toHaveProperty(
            "dismissFocusedElement",
        )
    })

    it("blocks parent shortcuts at the prompt keyboard boundary", async () => {
        const { scope, store } = setup()
        const parentAction = vi.fn()
        store.root.register(
            defineCommands({
                "help.toggle": {
                    id: "help.toggle",
                    keymap: "ctrl+h",
                    label: () => "Help",
                    category: "commands",
                    allowInInputs: true,
                    run: parentAction,
                },
            })["help.toggle"],
        )
        const event = createKeyboardEvent("h", "KeyH", { ctrlKey: true })

        await store.handleKeydown(event, scope)

        expect(parentAction).not.toHaveBeenCalled()
        expect(event.preventDefault).not.toHaveBeenCalled()
    })
})
