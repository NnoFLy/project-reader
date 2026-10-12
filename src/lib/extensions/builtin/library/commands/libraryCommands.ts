import { requestLibraryRelink } from "../state/relinkRequest.svelte"
import type { LibraryUIController } from "../state/libraryUI.svelte"
import { relinkLibraryNode } from "./libraryRelinkExecution"
import { goto } from "$app/navigation"
import { resolve } from "$app/paths"
import { localizedPath } from "../state/librarySettings"
import { vfsStore } from "../state/libraryStore.svelte"
import { getLibraryErrorDiagnostic } from "../state/libraryDiagnostics"
import type { FolderNode } from "../state/libraryStore.svelte"
import { defineCommands } from "./commands.types"
import { commandsStore } from "./commandsStore.svelte"
import type { PromptItem } from "./promptStore.svelte"
import { promptStore } from "./promptStore.svelte"
import {
    executeLibraryHostCommand,
    getLibraryHostBridge,
    getLibraryPrompt,
} from "../state/libraryHostBridge"
import PromptBookPreview from "../components/PromptBookPreview.svelte"
import * as m from "$lib/paraglide/messages"

function libraryPrompt() {
    return getLibraryPrompt() ?? promptStore
}

function executeHostCommand(commandId: string, payload?: unknown) {
    return getLibraryHostBridge()
        ? executeLibraryHostCommand(commandId, payload)
        : commandsStore.execute(commandId as never, payload as never)
}

function folderUrl(folderId: string | null): string {
    if (folderId === null) return localizedPath("/")
    const path = vfsStore.getNodePath(folderId).split(" / ").join("/")
    return `${localizedPath("/")}?folder=${encodeURIComponent(path)}`
}

function bookItems(recursive: boolean): PromptItem<string>[] {
    let files = [...vfsStore.allFiles].sort((a, b) => b.updatedAt - a.updatedAt)
    if (recursive && vfsStore.currentFolderId !== null) {
        const descendantIds = vfsStore.currentFolderDescendantIds
        files = files.filter((file) => descendantIds.has(file.id))
    }
    return files.map((fileNode) => {
        const parentPath = fileNode.parentId ? vfsStore.getNodePath(fileNode.parentId) : m.root()
        const pageNumber = fileNode.metadata.pageNumber || 1
        const pageInfo = pageNumber ? `${m.page()} ${pageNumber}` : m.not_read_yet()
        return {
            id: `book-${fileNode.id}`,
            label: fileNode.name,
            description: `${parentPath} / ${pageInfo}`,
            category: "books",
            value: fileNode.id,
            presentation: {
                kind: "book",
                leading: PromptBookPreview,
                leadingProps: { bookId: fileNode.id },
            },
        }
    })
}

function folderItems(): PromptItem<string | null>[] {
    const items: PromptItem<string | null>[] = []
    if (vfsStore.currentFolderId !== null) {
        items.push({
            id: "folder-root",
            label: m.root(),
            englishLabel: m.root({}, { locale: "en" }),
            category: "navigation",
            value: null,
        })
    }
    for (const folder of Object.values(vfsStore.nodes).filter(
        (node): node is FolderNode =>
            node.type === "folder" && node.id !== vfsStore.currentFolderId,
    )) {
        items.push({
            id: `folder-${folder.id}`,
            label: vfsStore.getNodePath(folder.id),
            category: "navigation",
            value: folder.id,
        })
    }
    return items
}

function collectInvalidMoveTargets(nodeIds: string[]): Set<string> {
    const invalid = new Set<string>()
    const collect = (folderId: string) => {
        const folder = vfsStore.nodes[folderId]
        if (!folder || folder.type !== "folder") return
        for (const childId of folder.childrenIds) {
            invalid.add(childId)
            collect(childId)
        }
    }
    for (const id of nodeIds) {
        const node = vfsStore.nodes[id]
        if (!node) continue
        invalid.add(id)
        if (node.type === "folder") collect(id)
    }
    return invalid
}

function moveTargetItems(nodeIds: string[]): PromptItem<string | null>[] {
    const items: PromptItem<string | null>[] = []
    if (nodeIds.some((id) => vfsStore.nodes[id]?.parentId !== null)) {
        items.push({
            id: "folder-root",
            label: m.root(),
            englishLabel: m.root({}, { locale: "en" }),
            value: null,
            category: "navigation",
        })
    }
    const invalid = collectInvalidMoveTargets(nodeIds)
    for (const folder of Object.values(vfsStore.nodes).filter(
        (node): node is FolderNode => node.type === "folder",
    )) {
        const alreadyThere = nodeIds.every((id) => vfsStore.nodes[id]?.parentId === folder.id)
        if (!alreadyThere && !invalid.has(folder.id)) {
            items.push({
                id: `folder-${folder.id}`,
                label: vfsStore.getNodePath(folder.id),
                value: folder.id,
                category: "navigation",
            })
        }
    }
    return items
}

async function moveNodes(
    libraryUI: LibraryUIController,
    nodeIds: string[],
    targetFolderId: string | null,
): Promise<void> {
    for (const id of nodeIds) {
        try {
            await vfsStore.moveNode(id, targetFolderId)
        } catch (error) {
            console.error(`Failed to move node ${id}:`, getLibraryErrorDiagnostic(error))
            alert(m.folder_rename_failed())
        }
    }
    libraryUI.nodeToMoveId = null
    libraryUI.isSelectionMode = false
    vfsStore.clearSelection()
}

export const libraryBookOpenCommand = defineCommands({
    "library.book.open": {
        id: "library.book.open",
        keymap: "o",
        label: () => m.keymap_open_book(),
        englishLabel: () => m.keymap_open_book({}, { locale: "en" }),
        category: "menu",
        run: async (payload) => {
            let bookId = payload?.bookId
            if (!bookId) {
                bookId = await libraryPrompt().choose({
                    id: "library-books",
                    items: () => bookItems(false),
                    filter: "fuzzy",
                })
            }
            if (bookId) await executeHostCommand("viewer.open", { bookId })
        },
    },
})["library.book.open"]

export function createLibraryCommands(libraryUI: LibraryUIController) {
    return defineCommands({
        "library.book.open": {
            id: "library.book.open",
            keymap: "o",
            label: () => m.keymap_open_book(),
            englishLabel: () => m.keymap_open_book({}, { locale: "en" }),
            category: "menu",
            run: async (payload) => {
                let bookId = payload?.bookId
                if (!bookId) {
                    bookId = await libraryPrompt().choose({
                        id: "library-books",
                        items: () => bookItems(false),
                        filter: "fuzzy",
                    })
                }
                if (bookId) await executeHostCommand("viewer.open", { bookId })
            },
        },
        "library.book.open-recursive": {
            id: "library.book.open-recursive",
            keymap: "o",
            label: () => m.keymap_open_books_recursive(),
            englishLabel: () => m.keymap_open_books_recursive({}, { locale: "en" }),
            category: "menu",
            run: async (payload) => {
                if (payload?.bookId) {
                    await executeHostCommand("viewer.open", { bookId: payload.bookId })
                    return
                }
                const bookId = await libraryPrompt().choose({
                    id: "library-books-recursive",
                    items: () => bookItems(true),
                    filter: "fuzzy",
                })
                if (bookId) {
                    await commandsStore.execute("library.book.open-recursive", { bookId })
                }
            },
        },
        "library.book.read-state.toggle": {
            id: "library.book.read-state.toggle",
            label: () => m.mark_as_read(),
            englishLabel: () => m.mark_as_read({}, { locale: "en" }),
            category: "commands",
            palette: false,
            run: async (payload) => {
                const node = payload?.nodeId ? vfsStore.nodes[payload.nodeId] : undefined
                if (!node || node.type !== "file") return
                const expectedGeneration = vfsStore.getContentGeneration(node.id)
                let total = node.metadata.totalPages
                if (!total) {
                    try {
                        total = (await vfsStore.getFilePageCount(node.id)) ?? undefined
                    } catch (error) {
                        console.error(
                            "Failed to read the document page count:",
                            getLibraryErrorDiagnostic(error),
                        )
                    }
                }
                if (!vfsStore.isCurrentContent(node.id, expectedGeneration)) return
                total ||= 1
                const isRead = (node.metadata.pageNumber || 1) === total
                const targetPage = (payload?.markAsRead ?? !isRead) ? total : 1
                await vfsStore.updateFile(
                    node.id,
                    {
                        metadata: {
                            ...node.metadata,
                            pageNumber: targetPage,
                            totalPages: total,
                        },
                    },
                    false,
                    expectedGeneration,
                )
            },
        },
        "library.folder.open": {
            id: "library.folder.open",
            keymap: "g",
            label: () => m.keymap_go_to_folder(),
            englishLabel: () => m.keymap_go_to_folder({}, { locale: "en" }),
            category: "menu",
            run: async (payload) => {
                if (payload && "folderId" in payload && payload.folderId !== undefined) {
                    await goto(resolve(folderUrl(payload.folderId) as any))
                    return
                }
                const folderId = await libraryPrompt().choose({
                    id: "library-folders",
                    items: folderItems,
                    filter: "fuzzy",
                })
                if (folderId !== undefined) {
                    await commandsStore.execute("library.folder.open", { folderId })
                }
            },
        },
        "library.folder.create": {
            id: "library.folder.create",
            label: () => m.new_folder(),
            englishLabel: () => m.new_folder({}, { locale: "en" }),
            category: "commands",
            disabled: () => libraryUI.isSelectionMode,
            run: async (payload) => {
                if (!payload?.name) {
                    libraryUI.isNewFolderModalOpen = true
                    return
                }
                await vfsStore.createFolder(payload.name, vfsStore.currentFolderId)
                libraryUI.isNewFolderModalOpen = false
            },
        },
        "library.node.rename": {
            id: "library.node.rename",
            label: () => m.rename_folder(),
            englishLabel: () => m.rename_folder({}, { locale: "en" }),
            category: "commands",
            palette: false,
            run: async (payload) => {
                const node = payload?.nodeId ? vfsStore.nodes[payload.nodeId] : undefined
                if (!node || node.type !== "folder") return
                if (payload?.name === undefined) {
                    libraryUI.folderToRenameId = node.id
                    libraryUI.isRenameFolderModalOpen = true
                    return
                }
                await vfsStore.renameFolder(node.id, payload.name)
                libraryUI.isRenameFolderModalOpen = false
                libraryUI.folderToRenameId = null
            },
        },
        "library.continue-reading": {
            id: "library.continue-reading",
            keymap: "shift+c",
            label: () => m.keymap_continue_reading(),
            englishLabel: () => m.keymap_continue_reading({}, { locale: "en" }),
            category: "navigation",
            disabled: () => !vfsStore.activeFileId || libraryUI.isPickingMode,
            run: async () => {
                if (vfsStore.activeFileId) {
                    await executeHostCommand("viewer.open", { bookId: vfsStore.activeFileId })
                }
            },
        },
        "library.primary-action": {
            id: "library.primary-action",
            keymap: "shift+a",
            label: () => {
                if (!libraryUI.isSelectionMode) return m.new_folder()
                const nodeIds = vfsStore.sortedCurrentNodes.map((node) => node.id)
                const allSelected =
                    nodeIds.length > 0 && nodeIds.every((id) => vfsStore.selectedIds.has(id))
                return allSelected ? m.keymap_exit_selection_mode() : m.select_all()
            },
            englishLabel: () => {
                if (!libraryUI.isSelectionMode) return m.new_folder({}, { locale: "en" })
                const nodeIds = vfsStore.sortedCurrentNodes.map((node) => node.id)
                const allSelected =
                    nodeIds.length > 0 && nodeIds.every((id) => vfsStore.selectedIds.has(id))
                return allSelected
                    ? m.keymap_exit_selection_mode({}, { locale: "en" })
                    : m.select_all({}, { locale: "en" })
            },
            category: "commands",
            run: async () => {
                if (!libraryUI.isSelectionMode) {
                    await commandsStore.execute("library.folder.create")
                    return
                }
                const nodeIds = vfsStore.sortedCurrentNodes.map((node) => node.id)
                const allSelected =
                    nodeIds.length > 0 && nodeIds.every((id) => vfsStore.selectedIds.has(id))
                await commandsStore.execute(
                    allSelected ? "library.selection.clear" : "library.selection.all",
                )
            },
        },
        "library.selection.toggle": {
            id: "library.selection.toggle",
            label: () => m.select(),
            category: "commands",
            palette: false,
            run: (payload) => {
                if (!payload?.nodeId) return
                libraryUI.isSelectionMode = true
                vfsStore.toggleSelection(payload.nodeId)
            },
        },
        "library.selection.all": {
            id: "library.selection.all",
            label: () => m.select_all(),
            englishLabel: () => m.select_all({}, { locale: "en" }),
            category: "commands",
            disabled: () => !libraryUI.isSelectionMode,
            run: () => {
                vfsStore.selectAll(vfsStore.sortedCurrentNodes.map((node) => node.id))
            },
        },
        "library.selection.clear": {
            id: "library.selection.clear",
            keymap: ["escape", "ctrl+c", "ctrl+[", "q"],
            label: () => m.keymap_exit_selection_mode(),
            englishLabel: () => m.keymap_exit_selection_mode({}, { locale: "en" }),
            category: "commands",
            allowInInputs: true,
            disabled: () => !libraryUI.isSelectionMode,
            run: () => {
                libraryUI.isPickingMode = false
                libraryUI.isSelectionMode = false
                vfsStore.clearSelection()
            },
        },
        "library.selection.move": {
            id: "library.selection.move",
            keymap: "shift+m",
            label: () => m.move(),
            englishLabel: () => m.move({}, { locale: "en" }),
            category: "commands",
            disabled: () => !libraryUI.isSelectionMode || vfsStore.selectedIds.size === 0,
            run: async (payload) => {
                const nodeIds = payload?.nodeIds ?? [...vfsStore.selectedIds]
                if (nodeIds.length === 0) return
                let targetFolderId = payload?.targetFolderId
                if (!payload || !("targetFolderId" in payload)) {
                    targetFolderId = await libraryPrompt().choose({
                        id: "library-move-target",
                        items: () => moveTargetItems(nodeIds),
                        filter: "fuzzy",
                    })
                    if (targetFolderId === undefined) return
                }
                await moveNodes(libraryUI, nodeIds, targetFolderId ?? null)
            },
        },
        "library.selection.delete": {
            id: "library.selection.delete",
            keymap: "shift+d",
            label: () => m.delete_selected(),
            englishLabel: () => m.delete_selected({}, { locale: "en" }),
            category: "commands",
            disabled: () => !libraryUI.isSelectionMode || vfsStore.selectedIds.size === 0,
            run: async (payload) => {
                const nodeIds = payload?.nodeIds ?? [...vfsStore.selectedIds]
                if (nodeIds.length === 0) return
                if (!payload?.confirmed) {
                    libraryUI.nodesToDeleteIds = nodeIds
                    libraryUI.isDeleteModalOpen = true
                    return
                }
                libraryUI.isDeleteModalOpen = false
                for (const id of nodeIds) await vfsStore.deleteNode(id)
                libraryUI.nodesToDeleteIds = []
                if (libraryUI.isSelectionMode && vfsStore.selectedIds.size === 0) {
                    libraryUI.isSelectionMode = false
                }
            },
        },
        "library.node.move": {
            id: "library.node.move",
            label: () => m.move(),
            category: "commands",
            palette: false,
            run: async (payload) => {
                if (!payload?.nodeId) return
                const nodeId = payload.nodeId
                let targetFolderId = payload.targetFolderId
                if (!("targetFolderId" in payload)) {
                    targetFolderId = await libraryPrompt().choose({
                        id: "library-move-target",
                        items: () => moveTargetItems([nodeId]),
                        filter: "fuzzy",
                    })
                    if (targetFolderId === undefined) return
                }
                await moveNodes(libraryUI, [nodeId], targetFolderId ?? null)
            },
        },
        "library.node.pin.toggle": {
            id: "library.node.pin.toggle",
            label: () => m.pin(),
            category: "commands",
            palette: false,
            run: async (payload) => {
                if (!payload?.nodeId) return
                const node = vfsStore.nodes[payload.nodeId]
                if (!node) return
                await vfsStore.setNodePinned(node.id, payload.isPinned ?? !node.isPinned)
            },
        },
        "library.node.delete": {
            id: "library.node.delete",
            label: () => m.delete_selected(),
            category: "commands",
            palette: false,
            run: async (payload) => {
                if (!payload?.nodeId) return
                if (!payload.confirmed) {
                    libraryUI.nodesToDeleteIds = [payload.nodeId]
                    libraryUI.isDeleteModalOpen = true
                    return
                }
                libraryUI.isDeleteModalOpen = false
                await vfsStore.deleteNode(payload.nodeId)
                libraryUI.nodesToDeleteIds = []
            },
        },
        "library.node.edit-metadata": {
            id: "library.node.edit-metadata",
            label: () => m.edit_metadata(),
            category: "commands",
            palette: false,
            run: async (payload) => {
                if (!payload?.nodeId) return
                if (payload.name === undefined || payload.pageNumber === undefined) {
                    libraryUI.nodeToEditMetadataId = payload.nodeId
                    libraryUI.isEditMetadataModalOpen = true
                    return
                }
                const node = vfsStore.nodes[payload.nodeId]
                if (!node || node.type !== "file") return
                const contentGeneration = vfsStore.getContentGeneration(node.id)
                await vfsStore.updateFile(
                    node.id,
                    {
                        name: payload.name,
                        metadata: {
                            author: payload.author ?? null,
                            pageNumber: payload.pageNumber,
                        },
                    },
                    false,
                    contentGeneration,
                )
                libraryUI.isEditMetadataModalOpen = false
            },
        },
        "library.node.relink": {
            id: "library.node.relink",
            label: () => m.locate_file(),
            category: "commands",
            palette: false,
            run: async (payload) => {
                if (!payload?.nodeId) return
                if (!payload.fileSource) {
                    requestLibraryRelink(payload.nodeId, () =>
                        executeHostCommand("viewer.open", { bookId: payload.nodeId }).then(
                            () => undefined,
                        ),
                    )
                    return
                }
                await relinkLibraryNode(payload.nodeId, payload.fileSource)
            },
        },
    })
}
