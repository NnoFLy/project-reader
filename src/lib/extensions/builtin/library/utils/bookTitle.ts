import type { FileNode } from "$lib/modules/documents"

export function resolveBookTitle(node: FileNode, preferPdfTitle: boolean): string {
    const pdfTitle = node.metadata.pdfTitle?.trim()
    return preferPdfTitle && pdfTitle ? pdfTitle : node.name
}
