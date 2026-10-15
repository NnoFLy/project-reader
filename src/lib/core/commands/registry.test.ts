import { describe, expect, it, vi } from "vitest"
import {
    findKeybindingConflicts,
    normalizeKeybinding,
    resolveHostKeybindings,
    type HostKeybinding,
} from "./registry"
import { KeyboardHandler } from "./keyboard"

describe("host keybinding dispatch support", () => {
    it("normalizes modifier order before detecting conflicts", () => {
        expect(normalizeKeybinding("Shift+Mod+O")).toBe("ctrl+o+shift")
        expect(normalizeKeybinding("+")).toBe("+")
        expect(normalizeKeybinding("?")).toBe("?")
        expect(
            KeyboardHandler.candidates({
                key: "?",
                code: "Slash",
                shiftKey: true,
                ctrlKey: false,
                metaKey: false,
                altKey: false,
            } as KeyboardEvent),
        ).toContain("?")
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

    it("filters disabled bindings and respects focused-input metadata", async () => {
        const disabled = vi.fn(() => false)
        const blockedInInput: HostKeybinding = {
            commandId: "viewer.blocked",
            keybinding: "ctrl+o",
            extensionId: "builtin.viewer",
            isEnabled: disabled,
        }
        const allowedInInput: HostKeybinding = {
            commandId: "viewer.allowed",
            keybinding: "ctrl+o",
            extensionId: "builtin.viewer",
            allowInInputs: true,
            isEnabled: () => true,
        }
        const inputEvent = {
            target: { tagName: "INPUT" },
        } as unknown as KeyboardEvent

        await expect(resolveHostKeybindings([blockedInInput], inputEvent)).resolves.toEqual([])
        expect(disabled).not.toHaveBeenCalled()
        await expect(
            resolveHostKeybindings([blockedInInput], {
                target: { tagName: "BUTTON" },
            } as unknown as KeyboardEvent),
        ).resolves.toEqual([])
        expect(disabled).toHaveBeenCalledOnce()
        await expect(resolveHostKeybindings([allowedInInput], inputEvent)).resolves.toEqual([
            allowedInInput,
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
