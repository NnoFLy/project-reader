import { describe, expect, it } from "vitest"
import {
    buildSidebarNavigationHints,
    findSidebarShortcut,
    isSidebarShortcutInputSafe,
} from "./sidebarShortcutHints"

const next = ["j", "arrowdown", "ctrl+n", "ctrl+j"]
const previous = ["k", "arrowup", "ctrl+p", "ctrl+k"]

describe("sidebar shortcut hints", () => {
    it("keeps all navigation aliases while search is unfocused", () => {
        expect(
            buildSidebarNavigationHints(next, previous, false).map(({ display }) => display),
        ).toEqual(["j/k", "↓/↑", "C-n/C-p", "C-j/C-k"])
    })

    it("keeps every input-safe alias and removes bare letters while search is focused", () => {
        const hints = buildSidebarNavigationHints(next, previous, true).map(
            ({ display }) => display,
        )
        expect(hints).toEqual(["↓/↑", "C-n/C-p", "C-j/C-k"])
        expect(next.filter(isSidebarShortcutInputSafe)).toEqual(["arrowdown", "ctrl+n", "ctrl+j"])
        expect(previous.filter(isSidebarShortcutInputSafe)).toEqual(["arrowup", "ctrl+p", "ctrl+k"])
    })

    it("selects focused edit and delete aliases from command keymaps", () => {
        expect(findSidebarShortcut(["e", "ctrl+e"], "ctrl+e")).toBe("C-e")
        expect(findSidebarShortcut(["d", "ctrl+d"], "ctrl+d")).toBe("C-d")
        expect(findSidebarShortcut(["e", "ctrl+e"], "e")).toBe("e")
        expect(findSidebarShortcut(["d", "ctrl+d"], "d")).toBe("d")
    })
})
