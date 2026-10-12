import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { vfsStore } from "$lib/modules/documents"
import type { VFSNodes } from "$lib/modules/documents"
import { createLibraryCommands } from "./libraryCommands"
import { LibraryUIController } from "../state/libraryUI.svelte"
import { createLibraryCardCommands } from "./cardEntityCommands"
import { CommandScope, commandsStore } from "$lib/modules/commands"
import { promptStore } from "$lib/modules/prompt"
import * as m from "$lib/paraglide/messages"

const libraryUI = new LibraryUIController()
const libraryCommands = createLibraryCommands(libraryUI)

const nodes: VFSNodes = {
    folder: {
        id: "folder",
        name: "Shelf",
        type: "folder",
        parentId: null,
        childrenIds: ["book"],
        createdAt: 1,
        updatedAt: 1,
        isPinned: false,
    },
    book: {
        id: "book",
        name: "Book.pdf",
        type: "file",
        parentId: "folder",
        size: 10,
        metadata: { pageNumber: 1 },
        createdAt: 1,
        updatedAt: 2,
        isPinned: false,
    },
}

let previousNodes: VFSNodes
let previousRootIds: string[]
let previousFolderId: string | null

beforeEach(() => {
    previousNodes = vfsStore.nodes
    previousRootIds = vfsStore.rootIds
    previousFolderId = vfsStore.currentFolderId
    vfsStore.nodes = nodes
    vfsStore.rootIds = ["folder"]
    vfsStore.currentFolderId = null
    vfsStore.clearSelection()
    libraryUI.clear()
})

afterEach(() => {
    promptStore.close()
    vfsStore.clearSelection()
    vfsStore.nodes = previousNodes
    vfsStore.rootIds = previousRootIds
    vfsStore.currentFolderId = previousFolderId
    libraryUI.clear()
})

describe("library commands", () => {
    it("gives every palette command a non-empty English alias", () => {
        for (const command of Object.values(libraryCommands)) {
            if ("palette" in command && command.palette === false) continue
            expect(
                "englishLabel" in command ? command.englishLabel().trim() : undefined,
                command.id,
            ).toBeTruthy()
        }
    })

    it("mirrors dynamic primary-action branches in the English alias", () => {
        const command = libraryCommands["library.primary-action"]
        expect(command.label()).toBe(m.new_folder())
        expect(command.englishLabel?.()).toBe(m.new_folder({}, { locale: "en" }))

        libraryUI.isSelectionMode = true
        expect(command.label()).toBe(m.select_all())
        expect(command.englishLabel?.()).toBe(m.select_all({}, { locale: "en" }))

        vfsStore.selectAll(vfsStore.sortedCurrentNodes.map((node) => node.id))
        expect(command.label()).toBe(m.keymap_exit_selection_mode())
        expect(command.englishLabel?.()).toBe(m.keymap_exit_selection_mode({}, { locale: "en" }))
    })

    it("opens and completes folder rename while retaining state on failure", async () => {
        const command = libraryCommands["library.node.rename"]
        await command.run({ nodeId: "folder" })
        expect(libraryUI.folderToRenameId).toBe("folder")
        expect(libraryUI.isRenameFolderModalOpen).toBe(true)

        const renameFolder = vi
            .spyOn(vfsStore, "renameFolder")
            .mockRejectedValueOnce(new Error("disk"))
        await expect(command.run({ nodeId: "folder", name: "New" })).rejects.toThrow("disk")
        expect(libraryUI.folderToRenameId).toBe("folder")
        expect(libraryUI.isRenameFolderModalOpen).toBe(true)

        renameFolder.mockResolvedValueOnce()
        await command.run({ nodeId: "folder", name: "New" })
        expect(renameFolder).toHaveBeenLastCalledWith("folder", "New")
        expect(libraryUI.folderToRenameId).toBeNull()
        expect(libraryUI.isRenameFolderModalOpen).toBe(false)
        renameFolder.mockRestore()
    })

    it("pins files and folders while safely ignoring stale IDs", async () => {
        const setNodePinned = vi.spyOn(vfsStore, "setNodePinned").mockResolvedValue()
        const command = libraryCommands["library.node.pin.toggle"]

        await command.run({ nodeId: "book" })
        expect(setNodePinned).toHaveBeenLastCalledWith("book", true)

        await command.run({ nodeId: "folder", isPinned: false })
        expect(setNodePinned).toHaveBeenLastCalledWith("folder", false)

        setNodePinned.mockClear()
        await command.run({ nodeId: "missing", isPinned: true })
        await command.run(undefined)
        expect(setNodePinned).not.toHaveBeenCalled()
        setNodePinned.mockRestore()
    })

    it("owns selection mutations", async () => {
        await libraryCommands["library.selection.toggle"].run({ nodeId: "book" })
        expect(libraryUI.isSelectionMode).toBe(true)
        expect(vfsStore.selectedIds.has("book")).toBe(true)

        await libraryCommands["library.selection.clear"].run()
        expect(libraryUI.isSelectionMode).toBe(false)
        expect(vfsStore.selectedIds.size).toBe(0)
    })

    it("opens the generic folder chooser instead of a Prompt mode", async () => {
        vfsStore.currentFolderId = "folder"
        const choosing = libraryCommands["library.folder.open"].run(undefined)
        await new Promise((resolve) => setTimeout(resolve, 0))

        expect(promptStore.snapshot?.request.id).toBe("library-folders")
        expect(promptStore.snapshot?.items.map(({ value }) => value)).toContain(null)

        promptStore.close()
        await choosing
    })

    it("moves selected nodes after choosing a target", async () => {
        const scope = new CommandScope()
        scope.register(libraryCommands["library.selection.move"])
        commandsStore.activate(scope)
        vfsStore.selectedIds.add("book")
        libraryUI.isSelectionMode = true
        const moveNode = vi.spyOn(vfsStore, "moveNode").mockResolvedValue()

        const executing = scope.execute("library.selection.move", { nodeIds: ["book"] })
        await new Promise((resolve) => setTimeout(resolve, 0))
        expect(promptStore.snapshot?.request.id).toBe("library-move-target")
        expect(promptStore.snapshot?.items.find(({ value }) => value === null)?.englishLabel).toBe(
            m.root({}, { locale: "en" }),
        )
        await promptStore.selectCurrent()
        await executing

        expect(moveNode).toHaveBeenCalledWith("book", null)
        moveNode.mockRestore()
        scope.destroy()
    })

    it("allows a card entity move while bulk selection mode is off", async () => {
        const parent = new CommandScope()
        parent.register(libraryCommands["library.node.move"])
        const child = new CommandScope(parent)
        child.registerAll(
            Object.values(
                createLibraryCardCommands({
                    getNodeId: () => "book",
                    isExecutable: () => true,
                    isSelected: () => false,
                    isRead: () => false,
                    setMenuOpen: () => {},
                    openNode: async () => {},
                    toggleSelection: async () => {},
                    moveNode: async (payload) => {
                        await parent.execute("library.node.move", payload)
                    },
                    deleteNode: async () => {},
                    editMetadata: async () => {},
                    toggleReadState: async () => {},
                    relink: async () => {},
                }),
            ),
        )
        commandsStore.activate(child)
        expect(libraryUI.isSelectionMode).toBe(false)
        const moveNode = vi.spyOn(vfsStore, "moveNode").mockResolvedValue()

        const executing = child.execute("library.node.move")
        await new Promise((resolve) => setTimeout(resolve, 0))
        expect(promptStore.snapshot?.request.id).toBe("library-move-target")
        await promptStore.selectCurrent()
        await executing

        expect(moveNode).toHaveBeenCalledWith("book", null)
        moveNode.mockRestore()
        child.destroy()
        parent.destroy()
    })

    it("routes card deletion through confirmation and the parent entity command", async () => {
        const parent = new CommandScope()
        parent.register(libraryCommands["library.node.delete"])
        const child = new CommandScope(parent)
        child.registerAll(
            Object.values(
                createLibraryCardCommands({
                    getNodeId: () => "book",
                    isExecutable: () => true,
                    isSelected: () => false,
                    isRead: () => false,
                    setMenuOpen: () => {},
                    openNode: async () => {},
                    toggleSelection: async () => {},
                    moveNode: async () => {},
                    deleteNode: async (payload) => {
                        await parent.execute("library.node.delete", payload)
                    },
                    editMetadata: async () => {},
                    toggleReadState: async () => {},
                    relink: async () => {},
                }),
            ),
        )
        const deleteNode = vi.spyOn(vfsStore, "deleteNode").mockResolvedValue()
        commandsStore.activate(child)

        await child.execute("library.node.delete")
        expect(libraryUI.isDeleteModalOpen).toBe(true)
        expect(libraryUI.nodesToDeleteIds).toEqual(["book"])
        await parent.execute("library.node.delete", { nodeId: "book", confirmed: true })
        expect(deleteNode).toHaveBeenCalledWith("book")

        deleteNode.mockRestore()
        child.destroy()
        parent.destroy()
    })

    it("opens a generic move-target chooser for selected nodes", async () => {
        vfsStore.selectedIds.add("book")
        libraryUI.isSelectionMode = true
        const choosing = libraryCommands["library.selection.move"].run(undefined)
        await new Promise((resolve) => setTimeout(resolve, 0))

        expect(promptStore.snapshot?.request.id).toBe("library-move-target")
        expect(promptStore.snapshot?.items.map(({ value }) => value)).toContain(null)

        promptStore.close()
        await choosing
    })
})
