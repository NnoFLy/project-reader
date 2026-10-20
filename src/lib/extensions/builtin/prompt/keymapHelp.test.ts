import { describe, expect, it } from "vitest"
import { KeyboardHandler } from "$lib/core/commands/keyboard"
import { buildKeymapHelpItems, filterKeymapHelpItems } from "./keymapHelp"

describe("keyboard help search", () => {
    const outline = { keys: KeyboardHandler.normalize("shift+o"), description: "Outline" }
    const previousPage = {
        keys: [KeyboardHandler.normalize("shift+space"), "arrowleft"],
        description: "Previous page",
    }
    const items = [outline, previousPage, { keys: "o", description: "Open book" }]

    it.each(["shift+o", "shift o", "shift-o", " SHIFT + O ", "shift - o", "shift   o"])(
        "finds normalized shortcuts using %j",
        (query) => {
            expect(filterKeymapHelpItems(items, query)).toEqual([outline])
        },
    )

    it.each(["shift+space", "shift space", "shift-space"])(
        "finds shortcuts in an alias array using %j",
        (query) => {
            expect(filterKeymapHelpItems(items, query)).toEqual([previousPage])
        },
    )

    it.each(["сохранить", "save note"])("finds descriptions using %j", (query) => {
        const localized = {
            keys: "ctrl+enter",
            description: "Сохранить заметку",
            englishDescription: "Save note",
        }
        expect(filterKeymapHelpItems([localized], query)).toEqual([localized])
    })

    it("preserves named-key, empty, and unmatched searches", () => {
        expect(filterKeymapHelpItems(items, "arrowleft")).toEqual([previousPage])
        expect(filterKeymapHelpItems(items, "")).toEqual(items)
        expect(filterKeymapHelpItems(items, "shift-x")).toEqual([])
    })

    it.each(["+", "-", "shift++", "shift+-"])(
        "keeps literal punctuation keys searchable using %j",
        (query) => {
            const item = { keys: KeyboardHandler.normalize(query), description: "Action" }
            expect(filterKeymapHelpItems([item], query)).toEqual([item])
        },
    )
})

describe("builtin prompt keyboard help", () => {
    const normalizeKey = (key: string) => key.toLowerCase()
    it("keeps scoped aliases ahead of shadowed host bindings", () => {
        expect(
            buildKeymapHelpItems(
                [
                    { label: "Outline", keymap: "shift+o" },
                    { label: "Open book", keymap: "shift+o" },
                ],
                normalizeKey,
            ),
        ).toEqual([{ keys: "shift+o", description: "Outline" }])
    })

    it("removes only shadowed aliases from a multi-key binding", () => {
        expect(
            buildKeymapHelpItems(
                [
                    { label: "Navigation", keymap: ["j", "arrowdown"] },
                    { label: "Other", keymap: ["j", "k"] },
                ],
                normalizeKey,
            ),
        ).toEqual([
            { keys: ["j", "arrowdown"], description: "Navigation" },
            { keys: ["k"], description: "Other" },
        ])
    })
})
