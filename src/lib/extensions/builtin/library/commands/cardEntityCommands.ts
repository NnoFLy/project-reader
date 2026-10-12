import { tick } from "svelte"
import { defineCommands } from "./commands.types"
import * as m from "$lib/paraglide/messages"
import {
    type LibraryBookReadStateTogglePayload,
    type LibraryCardOpenPayload,
    type LibraryNodeDeletePayload,
    type LibraryNodeEditMetadataPayload,
    type LibraryNodeMovePayload,
    type LibraryNodePinTogglePayload,
    type LibraryNodeRelinkPayload,
    type LibraryNodeRenamePayload,
    type LibrarySelectionTogglePayload,
    type LibraryCardCommandPayload,
    isLibraryBookReadStateTogglePayload,
    isLibraryCardOpenPayload,
    isLibraryNodeDeletePayload,
    isLibraryNodeEditMetadataPayload,
    isLibraryNodeMovePayload,
    isLibraryNodePinTogglePayload,
    isLibraryNodeRelinkPayload,
    isLibraryNodeRenamePayload,
    isLibrarySelectionTogglePayload,
} from "./libraryCommandPayloads"

type WithNodeId<T extends { nodeId?: string }> = LibraryCardCommandPayload<T>

export interface LibraryCardCommandContext {
    getNodeId: () => string | undefined
    isExecutable: () => boolean
    isSelected: () => boolean
    isRead: () => boolean
    isPinned?: () => boolean
    canToggleReadState?: () => boolean
    canEditMetadata?: () => boolean
    canRenameFolder?: () => boolean
    setMenuOpen: (open: boolean) => void
    openNode: (payload: WithNodeId<LibraryCardOpenPayload>) => Promise<void>
    toggleSelection: (payload: WithNodeId<LibrarySelectionTogglePayload>) => Promise<void>
    moveNode: (payload: WithNodeId<LibraryNodeMovePayload>) => Promise<void>
    togglePinned?: (payload: WithNodeId<LibraryNodePinTogglePayload>) => Promise<void>
    deleteNode: (payload: WithNodeId<LibraryNodeDeletePayload>) => Promise<void>
    editMetadata: (payload: WithNodeId<LibraryNodeEditMetadataPayload>) => Promise<void>
    renameFolder?: (payload: WithNodeId<LibraryNodeRenamePayload>) => Promise<void>
    toggleReadState: (payload: WithNodeId<LibraryBookReadStateTogglePayload>) => Promise<void>
    relink: (payload: WithNodeId<LibraryNodeRelinkPayload>) => Promise<void>
}

export function createLibraryCardCommands(context: LibraryCardCommandContext) {
    const withNodeId = <T extends { nodeId?: string }>(payload: T | undefined) => {
        const nodeId = payload?.nodeId ?? context.getNodeId()
        return nodeId ? ({ ...payload, nodeId } as T & { nodeId: string }) : undefined
    }
    const closeMenu = () => context.setMenuOpen(false)
    return defineCommands({
        "library.card.menu.toggle": {
            id: "library.card.menu.toggle",
            keymap: "e",
            label: () => m.more_options(),
            englishLabel: () => m.more_options({}, { locale: "en" }),
            category: "commands",
            disabled: () => !context.isExecutable(),
            run: async () => {
                await tick()
                context.setMenuOpen(true)
            },
        },
        "library.selection.toggle": {
            id: "library.selection.toggle",
            keymap: "space",
            label: () => (context.isSelected() ? m.deselect() : m.select()),
            englishLabel: () =>
                context.isSelected()
                    ? m.deselect({}, { locale: "en" })
                    : m.select({}, { locale: "en" }),
            category: "commands",
            disabled: () => !context.isExecutable(),
            palette: true,
            run: async (payload: LibrarySelectionTogglePayload | undefined) => {
                if (!isLibrarySelectionTogglePayload(payload)) return
                const merged = withNodeId(payload)
                if (!merged) return
                closeMenu()
                await context.toggleSelection(merged)
            },
        },
        "library.card.open": {
            id: "library.card.open",
            keymap: "enter",
            label: () => m.open(),
            englishLabel: () => m.open({}, { locale: "en" }),
            category: "navigation",
            disabled: () => !context.isExecutable(),
            palette: true,
            run: async (payload: LibraryCardOpenPayload | undefined) => {
                if (!isLibraryCardOpenPayload(payload)) return
                const merged = withNodeId(payload)
                if (merged) await context.openNode(merged)
            },
        },
        "library.node.move": {
            id: "library.node.move",
            label: () => m.move(),
            englishLabel: () => m.move({}, { locale: "en" }),
            category: "commands",
            disabled: () => !context.isExecutable(),
            palette: true,
            run: async (payload: LibraryNodeMovePayload | undefined) => {
                if (!isLibraryNodeMovePayload(payload)) return
                const merged = withNodeId(payload)
                if (!merged) return
                closeMenu()
                await context.moveNode(merged)
            },
        },
        "library.node.pin.toggle": {
            id: "library.node.pin.toggle",
            label: () => (context.isPinned?.() ? m.unpin() : m.pin()),
            englishLabel: () =>
                context.isPinned?.() ? m.unpin({}, { locale: "en" }) : m.pin({}, { locale: "en" }),
            category: "commands",
            disabled: () => !context.isExecutable(),
            palette: true,
            run: async (payload: LibraryNodePinTogglePayload | undefined) => {
                if (!isLibraryNodePinTogglePayload(payload)) return
                const merged = withNodeId({
                    ...payload,
                    isPinned: payload?.isPinned ?? !context.isPinned?.(),
                })
                if (!merged) return
                closeMenu()
                await context.togglePinned?.(merged)
            },
        },
        "library.node.delete": {
            id: "library.node.delete",
            label: () => m.delete_selected(),
            englishLabel: () => m.delete_selected({}, { locale: "en" }),
            category: "commands",
            disabled: () => !context.isExecutable(),
            palette: true,
            run: async (payload: LibraryNodeDeletePayload | undefined) => {
                if (!isLibraryNodeDeletePayload(payload)) return
                const merged = withNodeId(payload)
                if (!merged) return
                closeMenu()
                await context.deleteNode(merged)
            },
        },
        "library.node.rename": {
            id: "library.node.rename",
            keymap: "r",
            label: () => (context.canRenameFolder?.() === true ? m.rename() : m.edit_metadata()),
            englishLabel: () =>
                context.canRenameFolder?.() === true
                    ? m.rename({}, { locale: "en" })
                    : m.edit_metadata({}, { locale: "en" }),
            category: "commands",
            disabled: () =>
                !context.isExecutable() ||
                (context.canRenameFolder?.() === false && context.canEditMetadata?.() === false),
            palette: true,
            run: async (payload: LibraryNodeRenamePayload | undefined) => {
                if (!isLibraryNodeRenamePayload(payload)) return
                const merged = withNodeId(payload)
                if (!merged) return
                closeMenu()
                if (context.canRenameFolder?.() === true) {
                    await context.renameFolder?.(merged)
                } else {
                    await context.editMetadata(merged)
                }
            },
        },
        "library.node.edit-metadata": {
            id: "library.node.edit-metadata",
            label: () => m.edit_metadata(),
            englishLabel: () => m.edit_metadata({}, { locale: "en" }),
            category: "commands",
            disabled: () => !context.isExecutable() || context.canEditMetadata?.() === false,
            palette: true,
            run: async (payload: LibraryNodeEditMetadataPayload | undefined) => {
                if (!isLibraryNodeEditMetadataPayload(payload)) return
                const merged = withNodeId(payload)
                if (!merged) return
                closeMenu()
                await context.editMetadata(merged)
            },
        },
        "library.book.read-state.toggle": {
            id: "library.book.read-state.toggle",
            label: () => (context.isRead() ? m.mark_as_unread() : m.mark_as_read()),
            englishLabel: () =>
                context.isRead()
                    ? m.mark_as_unread({}, { locale: "en" })
                    : m.mark_as_read({}, { locale: "en" }),
            category: "commands",
            disabled: () => !context.isExecutable() || context.canToggleReadState?.() === false,
            palette: true,
            run: async (payload: LibraryBookReadStateTogglePayload | undefined) => {
                if (!isLibraryBookReadStateTogglePayload(payload)) return
                const merged = withNodeId({
                    ...payload,
                    markAsRead: payload?.markAsRead ?? !context.isRead(),
                })
                if (!merged) return
                closeMenu()
                await context.toggleReadState(merged)
            },
        },
        "library.node.relink": {
            id: "library.node.relink",
            label: () => m.locate_file(),
            englishLabel: () => m.locate_file({}, { locale: "en" }),
            category: "commands",
            disabled: () => !context.isExecutable(),
            palette: true,
            run: async (payload: LibraryNodeRelinkPayload | undefined) => {
                if (!isLibraryNodeRelinkPayload(payload)) return
                const merged = withNodeId(payload)
                if (!merged) return
                closeMenu()
                await context.relink(merged)
            },
        },
    })
}
