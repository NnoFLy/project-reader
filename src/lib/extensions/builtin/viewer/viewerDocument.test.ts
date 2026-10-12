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
        expect(loaded.kind).toBe("paged")
        if (loaded.kind !== "paged") throw new Error("expected paged document")
        expect(await loaded.getText?.(1)).toEqual([{ text: "test" }])

        await loaded.close()
        expect(service.close).toHaveBeenCalledWith(document)
    })

    it("keeps optional text extraction absent without rejecting the document", async () => {
        const renderOnly = {
            kind: "paged" as const,
            metadata: { title: "Render only", author: null, pageCount: 1 },
            capabilities: new Set(),
            pageCount: 1,
            getPage: vi.fn(async () => ({ pageNumber: 1, width: 1, height: 1 })),
            renderPage: vi.fn(),
            close: vi.fn(async () => undefined),
        } satisfies OpenedDocument
        vi.mocked(service.open).mockResolvedValueOnce(renderOnly)

        const loaded = await getViewerDocumentLoader().open({
            id: "render-only",
            name: "render-only.bin",
            url: "blob:render-only",
        })

        expect(loaded.kind).toBe("paged")
        if (loaded.kind !== "paged") throw new Error("expected paged document")
        expect(loaded.getText).toBeUndefined()
        await loaded.close()
        expect(service.close).toHaveBeenCalledWith(renderOnly)
    })

    it("preserves reflow sections instead of treating them as paged data", async () => {
        const reflowable = {
            kind: "reflowable" as const,
            metadata: { title: "Reflow", author: null },
            capabilities: new Set(),
            getSections: vi.fn(async () => [{ id: "intro", title: "Intro", content: "Hello" }]),
            close: vi.fn(async () => undefined),
        } satisfies OpenedDocument
        vi.mocked(service.open).mockResolvedValueOnce(reflowable)

        const loaded = await getViewerDocumentLoader().open({
            id: "reflow",
            name: "reflow.book",
            url: "blob:reflow",
        })

        expect(loaded.kind).toBe("reflowable")
        if (loaded.kind !== "reflowable") throw new Error("expected reflowable document")
        await expect(loaded.getSections()).resolves.toEqual([
            { id: "intro", title: "Intro", content: "Hello" },
        ])
        await loaded.close()
        expect(service.close).toHaveBeenCalledWith(reflowable)
    })
})
