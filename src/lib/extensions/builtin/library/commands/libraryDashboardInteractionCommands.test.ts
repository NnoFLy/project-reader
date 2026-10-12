import { describe, expect, it, vi } from "vitest"
import { createLibraryDashboardInteractionCommands } from "./libraryDashboardInteractionCommands"

const labelSet = {
    down: () => "Down",
    up: () => "Up",
    left: () => "Left",
    right: () => "Right",
    openPicker: () => "Open picker",
    focusPicker: () => "Focus picker",
    selectionPicker: () => "Selection picker",
    upFolder: () => "Up folder",
    cardSizeDecrease: () => "Decrease card size",
    cardSizeIncrease: () => "Increase card size",
}

describe("library dashboard command aliases", () => {
    it("gives every dashboard command a non-empty English alias", () => {
        const commands = createLibraryDashboardInteractionCommands({
            gridDisabled: () => false,
            moveGrid: vi.fn(),
            startOpenPicker: vi.fn(),
            startFocusPicker: vi.fn(),
            startSelectionPicker: vi.fn(),
            goUpFolder: vi.fn(),
            decreaseCardSize: vi.fn(),
            increaseCardSize: vi.fn(),
            cardSizeDecreaseDisabled: () => false,
            cardSizeIncreaseDisabled: () => false,
            labels: labelSet,
            englishLabels: labelSet,
        })

        for (const command of commands) {
            expect(command.englishLabel?.().trim(), command.id).toBeTruthy()
        }
    })

    it("uses unique card-size shortcuts and remaps up-folder to Backspace", () => {
        const decreaseCardSize = vi.fn()
        const increaseCardSize = vi.fn()
        const commands = createLibraryDashboardInteractionCommands({
            gridDisabled: () => false,
            moveGrid: vi.fn(),
            startOpenPicker: vi.fn(),
            startFocusPicker: vi.fn(),
            startSelectionPicker: vi.fn(),
            goUpFolder: vi.fn(),
            decreaseCardSize,
            increaseCardSize,
            cardSizeDecreaseDisabled: () => false,
            cardSizeIncreaseDisabled: () => false,
            labels: labelSet,
            englishLabels: labelSet,
        })
        const byId = Object.fromEntries(commands.map((command) => [command.id, command]))

        expect(byId["library.folder.up"].keymap).toBe("backspace")
        expect(byId["library.card-size.decrease"].keymap).toBe("-")
        expect(byId["library.card-size.increase"].keymap).toEqual(["+", "="])
        byId["library.card-size.decrease"].run(undefined)
        byId["library.card-size.increase"].run(undefined)
        expect(decreaseCardSize).toHaveBeenCalledOnce()
        expect(increaseCardSize).toHaveBeenCalledOnce()
    })
})
