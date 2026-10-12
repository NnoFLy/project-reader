import { describe, expect, it } from "vitest"
import { findKeybindingConflicts, normalizeKeybinding, type HostKeybinding } from "./registry"

describe("host keybinding dispatch support", () => {
    it("normalizes modifier order before detecting conflicts", () => {
        expect(normalizeKeybinding("Shift+Mod+O")).toBe("ctrl+o+shift")
        const bindings: HostKeybinding[] = [
            { commandId: "viewer.open", keybinding: "ctrl+shift+o", extensionId: "builtin.viewer" },
            {
                commandId: "library.open",
                keybinding: "Shift+Mod+O",
                extensionId: "builtin.library",
            },
        ]

        expect(findKeybindingConflicts(bindings)).toEqual([
            ["ctrl+o+shift", [bindings[1], bindings[0]]],
        ])
    })

    it("does not report unique bindings as conflicts", () => {
        expect(
            findKeybindingConflicts([
                { commandId: "viewer.open", keybinding: "ctrl+o", extensionId: "builtin.viewer" },
            ]),
        ).toEqual([])
    })
})
