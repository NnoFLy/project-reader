import { describe, expect, it, vi } from "vitest"
import { createLibraryCardCommands } from "./cardEntityCommands"
import * as m from "$lib/paraglide/messages"

describe("bound library card commands", () => {
    it("gives every palette command a non-empty English alias", () => {
        const commands = createLibraryCardCommands({
            getNodeId: () => "book",
            isExecutable: () => true,
            isSelected: () => false,
            isRead: () => false,
            canToggleReadState: () => true,
            setMenuOpen: vi.fn(),
            openNode: vi.fn(),
            toggleSelection: vi.fn(),
            moveNode: vi.fn(),
            deleteNode: vi.fn(),
            editMetadata: vi.fn(),
            toggleReadState: vi.fn(),
            relink: vi.fn(),
        })

        for (const command of Object.values(commands)) {
            expect(command.englishLabel?.().trim(), command.id).toBeTruthy()
        }
    })

    it("opens more options after the command palette releases focus", async () => {
        const setMenuOpen = vi.fn()
        const commands = createLibraryCardCommands({
            getNodeId: () => "book",
            isExecutable: () => true,
            isSelected: () => false,
            isRead: () => false,
            setMenuOpen,
            openNode: vi.fn(),
            toggleSelection: vi.fn(),
            moveNode: vi.fn(),
            deleteNode: vi.fn(),
            editMetadata: vi.fn(),
            toggleReadState: vi.fn(),
            relink: vi.fn(),
        })

        const opening = commands["library.card.menu.toggle"].run()
        expect(setMenuOpen).not.toHaveBeenCalled()
        await opening
        expect(setMenuOpen).toHaveBeenCalledWith(true)
    })

    it("remain executable after card focus moves to the command palette", async () => {
        const moveNode = vi.fn().mockResolvedValue(undefined)
        const commands = createLibraryCardCommands({
            getNodeId: () => "book",
            isExecutable: () => true,
            isSelected: () => false,
            isRead: () => false,
            setMenuOpen: vi.fn(),
            openNode: vi.fn(),
            toggleSelection: vi.fn(),
            moveNode,
            deleteNode: vi.fn(),
            editMetadata: vi.fn(),
            toggleReadState: vi.fn(),
            relink: vi.fn(),
        })

        expect(commands["library.node.move"].disabled?.()).toBe(false)
        await commands["library.node.move"].run(undefined)
        expect(moveNode).toHaveBeenCalledWith({ nodeId: "book" })
    })

    it("preserves complete metadata and relink payloads", async () => {
        const editMetadata = vi.fn().mockResolvedValue(undefined)
        const relink = vi.fn().mockResolvedValue(undefined)
        const commands = createLibraryCardCommands({
            getNodeId: () => "book",
            isExecutable: () => true,
            isSelected: () => false,
            isRead: () => false,
            setMenuOpen: vi.fn(),
            openNode: vi.fn(),
            toggleSelection: vi.fn(),
            moveNode: vi.fn(),
            deleteNode: vi.fn(),
            editMetadata,
            toggleReadState: vi.fn(),
            relink,
        })
        const fileSource = new File(["pdf"], "book.pdf")

        await commands["library.node.edit-metadata"].run({
            name: "Renamed",
            author: "Author",
            pageNumber: 12,
        })
        await commands["library.node.relink"].run({ fileSource })

        expect(editMetadata).toHaveBeenCalledWith({
            nodeId: "book",
            name: "Renamed",
            author: "Author",
            pageNumber: 12,
        })
        expect(relink).toHaveBeenCalledWith({ nodeId: "book", fileSource })
    })

    it("describes selection and read-state toggles using their current actions", async () => {
        let selected = false
        let read = false
        const toggleReadState = vi.fn().mockResolvedValue(undefined)
        const commands = createLibraryCardCommands({
            getNodeId: () => "book",
            isExecutable: () => true,
            isSelected: () => selected,
            isRead: () => read,
            setMenuOpen: vi.fn(),
            openNode: vi.fn(),
            toggleSelection: vi.fn(),
            moveNode: vi.fn(),
            deleteNode: vi.fn(),
            editMetadata: vi.fn(),
            toggleReadState,
            relink: vi.fn(),
        })

        expect(commands["library.selection.toggle"].label()).toBe(m.select())
        expect(commands["library.selection.toggle"].englishLabel?.()).toBe(
            m.select({}, { locale: "en" }),
        )
        expect(commands["library.book.read-state.toggle"].label()).toBe(m.mark_as_read())
        await commands["library.book.read-state.toggle"].run(undefined)
        expect(toggleReadState).toHaveBeenLastCalledWith({ nodeId: "book", markAsRead: true })

        selected = true
        read = true
        expect(commands["library.selection.toggle"].label()).toBe(m.deselect())
        expect(commands["library.selection.toggle"].englishLabel?.()).toBe(
            m.deselect({}, { locale: "en" }),
        )
        expect(commands["library.book.read-state.toggle"].label()).toBe(m.mark_as_unread())
        expect(commands["library.book.read-state.toggle"].englishLabel?.()).toBe(
            m.mark_as_unread({}, { locale: "en" }),
        )
        await commands["library.book.read-state.toggle"].run(undefined)
        expect(toggleReadState).toHaveBeenLastCalledWith({ nodeId: "book", markAsRead: false })
    })

    it("describes and forwards deterministic pin targets", async () => {
        let pinned = false
        const setMenuOpen = vi.fn()
        const togglePinned = vi.fn().mockResolvedValue(undefined)
        const commands = createLibraryCardCommands({
            getNodeId: () => "book",
            isExecutable: () => true,
            isSelected: () => false,
            isRead: () => false,
            isPinned: () => pinned,
            setMenuOpen,
            openNode: vi.fn(),
            toggleSelection: vi.fn(),
            moveNode: vi.fn(),
            togglePinned,
            deleteNode: vi.fn(),
            editMetadata: vi.fn(),
            toggleReadState: vi.fn(),
            relink: vi.fn(),
        })
        const command = commands["library.node.pin.toggle"]

        expect(command.label()).toBe(m.pin())
        expect(command.englishLabel?.()).toBe(m.pin({}, { locale: "en" }))
        await command.run(undefined)
        expect(setMenuOpen).toHaveBeenLastCalledWith(false)
        expect(togglePinned).toHaveBeenLastCalledWith({ nodeId: "book", isPinned: true })

        pinned = true
        expect(command.label()).toBe(m.unpin())
        expect(command.englishLabel?.()).toBe(m.unpin({}, { locale: "en" }))
        await command.run({ isPinned: true })
        expect(togglePinned).toHaveBeenLastCalledWith({ nodeId: "book", isPinned: true })
    })

    it("binds r to the type-appropriate rename action", async () => {
        const folderCommands = createLibraryCardCommands({
            getNodeId: () => "folder",
            isExecutable: () => true,
            isSelected: () => false,
            isRead: () => false,
            canEditMetadata: () => false,
            canRenameFolder: () => true,
            setMenuOpen: vi.fn(),
            openNode: vi.fn(),
            toggleSelection: vi.fn(),
            moveNode: vi.fn(),
            deleteNode: vi.fn(),
            editMetadata: vi.fn(),
            renameFolder: vi.fn(),
            toggleReadState: vi.fn(),
            relink: vi.fn(),
        })
        expect(folderCommands["library.node.rename"].keymap).toBe("r")
        expect(folderCommands["library.node.rename"].disabled?.()).toBe(false)
        expect(folderCommands["library.node.edit-metadata"].disabled?.()).toBe(true)

        const editMetadata = vi.fn().mockResolvedValue(undefined)
        const bookCommands = createLibraryCardCommands({
            getNodeId: () => "book",
            isExecutable: () => true,
            isSelected: () => false,
            isRead: () => false,
            canEditMetadata: () => true,
            canRenameFolder: () => false,
            setMenuOpen: vi.fn(),
            openNode: vi.fn(),
            toggleSelection: vi.fn(),
            moveNode: vi.fn(),
            deleteNode: vi.fn(),
            editMetadata,
            renameFolder: vi.fn(),
            toggleReadState: vi.fn(),
            relink: vi.fn(),
        })
        expect(bookCommands["library.node.rename"].keymap).toBe("r")
        expect(bookCommands["library.node.rename"].label()).toBe(m.edit_metadata())
        expect(bookCommands["library.node.rename"].disabled?.()).toBe(false)
        await bookCommands["library.node.rename"].run(undefined)
        expect(editMetadata).toHaveBeenCalledWith({ nodeId: "book" })
    })

    it("disables read-state changes for folders", () => {
        const commands = createLibraryCardCommands({
            getNodeId: () => "folder",
            isExecutable: () => true,
            isSelected: () => false,
            isRead: () => false,
            canToggleReadState: () => false,
            setMenuOpen: vi.fn(),
            openNode: vi.fn(),
            toggleSelection: vi.fn(),
            moveNode: vi.fn(),
            deleteNode: vi.fn(),
            editMetadata: vi.fn(),
            toggleReadState: vi.fn(),
            relink: vi.fn(),
        })

        expect(commands["library.book.read-state.toggle"].disabled?.()).toBe(true)
        expect(commands["library.card.open"].disabled?.()).toBe(false)
    })

    it("disables all entity actions only when the card itself is unavailable", () => {
        const commands = createLibraryCardCommands({
            getNodeId: () => "book",
            isExecutable: () => false,
            isSelected: () => false,
            isRead: () => false,
            setMenuOpen: vi.fn(),
            openNode: vi.fn(),
            toggleSelection: vi.fn(),
            moveNode: vi.fn(),
            deleteNode: vi.fn(),
            editMetadata: vi.fn(),
            toggleReadState: vi.fn(),
            relink: vi.fn(),
        })

        expect(Object.values(commands).every((command) => command.disabled?.())).toBe(true)
    })
})
