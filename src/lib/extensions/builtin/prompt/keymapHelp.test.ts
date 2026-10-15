import { describe, expect, it } from "vitest"
import { buildKeymapHelpItems } from "./keymapHelp"

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
