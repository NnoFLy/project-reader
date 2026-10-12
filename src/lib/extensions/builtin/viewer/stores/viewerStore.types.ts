import type { FileNode } from "$lib/modules/documents"

export interface Book {
    id: string
    name: string
    updatedAt: number
    pageNumber: number
    scrollPosition?: number
    url?: string
    pdfDest?: string
    isLocked?: boolean
    previewDataUrl?: string
    totalPages?: number
    author?: string | null
}

export function fileNodeToBook(node: FileNode): Book {
    return {
        id: node.id,
        name: node.name,
        updatedAt: node.updatedAt,
        pageNumber: node.metadata.pageNumber || 1,
        scrollPosition: node.metadata.scrollPosition || 0,
        pdfDest: node.metadata.pdfDest,
        totalPages: node.metadata.totalPages,
        author: node.metadata.author,
    }
}
