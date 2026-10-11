export {
    default as PDFDocument,
    Page,
    type FlatHeading,
    PDF_RESOURCE_LIMITS,
    PDFResourceLimitError,
    assertPdfFileSize,
} from "./pdf"

export async function createSearchWorker(): Promise<Worker> {
    const SearchWorker = (await import("./searchWorker?worker")).default
    return new SearchWorker()
}
