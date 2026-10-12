import { describe, expect, it } from "vitest"
import {
    DEFAULT_LIBRARY_CARD_SIZE_LEVEL,
    LibraryUIController,
    parseLibraryCardSizeLevel,
} from "./libraryUI.svelte"

describe("LibraryUIController", () => {
    it("clears workflow state", () => {
        const state = new LibraryUIController()
        state.isSelectionMode = true
        state.isPickingMode = true
        state.isNewFolderModalOpen = true
        state.isDeleteModalOpen = true
        state.nodesToDeleteIds = ["one"]
        state.nodeToMoveId = "two"
        state.isEditMetadataModalOpen = true
        state.nodeToEditMetadataId = "three"
        state.isRenameFolderModalOpen = true
        state.folderToRenameId = "folder"

        state.clear()

        expect(state.isSelectionMode).toBe(false)
        expect(state.isPickingMode).toBe(false)
        expect(state.isNewFolderModalOpen).toBe(false)
        expect(state.isDeleteModalOpen).toBe(false)
        expect(state.nodesToDeleteIds).toEqual([])
        expect(state.nodeToMoveId).toBeNull()
        expect(state.isEditMetadataModalOpen).toBe(false)
        expect(state.nodeToEditMetadataId).toBeNull()
        expect(state.isRenameFolderModalOpen).toBe(false)
        expect(state.folderToRenameId).toBeNull()
    })

    it("bounds card sizes", () => {
        const state = new LibraryUIController()
        for (let index = 0; index < 10; index += 1) state.decreaseCardSize()
        expect(state.cardSizeLevel).toBe(0)
        expect(state.canDecreaseCardSize).toBe(false)

        for (let index = 0; index < 10; index += 1) state.increaseCardSize()
        expect(state.cardSizeLevel).toBe(3)
        expect(state.canIncreaseCardSize).toBe(false)
    })

    it("rejects malformed persisted card-size levels", () => {
        expect(parseLibraryCardSizeLevel(null)).toBe(DEFAULT_LIBRARY_CARD_SIZE_LEVEL)
        expect(parseLibraryCardSizeLevel("not-a-number")).toBe(DEFAULT_LIBRARY_CARD_SIZE_LEVEL)
        expect(parseLibraryCardSizeLevel("-1")).toBe(DEFAULT_LIBRARY_CARD_SIZE_LEVEL)
        expect(parseLibraryCardSizeLevel("4")).toBe(DEFAULT_LIBRARY_CARD_SIZE_LEVEL)
        expect(parseLibraryCardSizeLevel("2")).toBe(2)
    })

    it("creates independent instances", () => {
        const first = new LibraryUIController()
        const second = new LibraryUIController()
        first.isSelectionMode = true
        first.nodesToDeleteIds = ["one"]
        expect(second.isSelectionMode).toBe(false)
        expect(second.nodesToDeleteIds).toEqual([])
    })
})
