export type FileType = "folder" | "file"

export interface BaseNode {
    id: string
    name: string
    type: FileType
    parentId: string | null
    createdAt: number
    updatedAt: number
    isPinned: boolean
}

export interface BookPreview {
    id: string
    data: Blob
}

export interface FileContent {
    id: string
    file?: File | Blob
    handle?: FileSystemFileHandle
}

export interface FolderNode extends BaseNode {
    type: "folder"
    childrenIds: string[]
}

export type BookMetadata = {
    pageNumber: number
    scrollPosition?: number
    pdfDest?: string
    totalPages?: number
    author?: string | null
    pdfTitle?: string | null
}

export type ImportStage = "queued" | "saving" | "metadata" | "failed"

export interface ImportJob {
    id: string
    name: string
    parentId: string | null
    stage: ImportStage
    failure?: "invalid-file" | "persistence"
}

export interface ImportInput {
    name: string
    source: File | FileSystemFileHandle
}

export interface ImportResult {
    id: string
    name: string
    status: "imported" | "rejected" | "failed"
}

export interface ImportCallbacks {
    onImported?: (result: ImportResult) => void | Promise<void>
    onFailure?: (result: ImportResult, phase: "validation" | "persistence" | "metadata") => void
}

export interface FileNode extends BaseNode {
    type: "file"
    isLocked?: boolean
    /** Set only when a resource-limited import needs durable cleanup on next initialization. */
    cleanupPending?: "resource-limit"
    size: number
    metadata: BookMetadata
}

export type VFSNode = FolderNode | FileNode
export type VFSNodes = Record<string, VFSNode>

export type FolderNameErrorCode = "empty" | "slash" | "duplicate"

export class FolderNameError extends Error {
    constructor(public readonly code: FolderNameErrorCode) {
        super(`Invalid folder name: ${code}`)
        this.name = "FolderNameError"
    }
}

export interface VFS {
    nodes: VFSNodes
    rootIds: string[]
    activeNodeId: string | null
}

export interface IndexedText {
    id: string
    bookId: string
    pageNumber: number
    text: string
}

export interface UserNote {
    id: string
    bookId: string
    pageNumber: number
    start: number
    end: number
    text: string
    noteContent: string
    color: "yellow" | "green" | "blue" | "pink" | "purple"
    createdAt: number
}

export interface Bookmark {
    id: string
    bookId: string
    pageNumber: number
    name: string
    createdAt: number
}
