import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { OpenedDocument } from "$lib/document-model"
import {
    getViewerDocumentLoader,
    installViewerDocumentService,
    type ViewerDocumentService,
} from "./viewerDocument"

const document = {
    kind: "paged" as const,
    metadata: { title: "Test", author: null, pageCount: 1 },
    capabilities: new Set(["text"]),
    pageCount: 1,
    getText: vi.fn(async () => [{ text: "test" }]),
    getPage: vi.fn(async () => ({
        pageNumber: 1,
        url: "data:image/png;base64,test",
        width: 1,
        height: 1,
        mimeType: "image/png",
    })),
    renderPage: vi.fn(),
    close: vi.fn(async () => undefined),
} as unknown as OpenedDocument

const service = {
    open: vi.fn(async () => document),
    close: vi.fn(async (opened: OpenedDocument) => opened.close()),
} satisfies ViewerDocumentService

beforeEach(() => {
    vi.stubGlobal(
        "fetch",
        vi.fn(
            async () =>
                new Response(new Blob(["%PDF-test"], { type: "application/pdf" }), { status: 200 }),
        ),
    )
    vi.mocked(service.open).mockClear()
    vi.mocked(service.close).mockClear()
    installViewerDocumentService(service)
})

afterEach(() => {
    installViewerDocumentService(undefined)
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
})

describe("viewer document loading", () => {
    it("loads and closes documents through the host-provided service", async () => {
        const loaded = await getViewerDocumentLoader().open({
            id: "book",
            name: "book.pdf",
            url: "blob:book",
        })

        expect(service.open).toHaveBeenCalledWith(
            expect.objectContaining({ name: "book.pdf" }),
            undefined,
        )
        expect(await loaded.getText(1)).toEqual([{ text: "test" }])

        await loaded.close()
        expect(service.close).toHaveBeenCalledWith(document)
    })
})
