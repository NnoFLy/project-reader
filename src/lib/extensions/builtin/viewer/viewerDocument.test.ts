// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { OpenedDocument } from "$lib/document-model"
import {
    getViewerDocumentErrorDiagnostic,
    getViewerDocumentLoader,
    installViewerDocumentService,
    renderViewerPageLayers,
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
    it("sanitizes adapter diagnostics without exposing the original exception", () => {
        const error = new Error("secret source URL and parser details")

        expect(getViewerDocumentErrorDiagnostic(error)).toEqual({
            name: "DocumentError",
            message: "Unable to open document",
        })
        expect(JSON.stringify(getViewerDocumentErrorDiagnostic(error))).not.toContain(error.message)
    })

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

    it("renders positioned text and rejects unsafe annotation URLs", async () => {
        const textContainer = globalThis.document.createElement("div")
        const annotationContainer = globalThis.document.createElement("div")
        const paged = {
            getText: vi.fn(async () => [{ text: "Hello", x: 12, y: 24, width: 30, height: 10 }]),
            getAnnotations: vi.fn(async () => [
                {
                    type: "link",
                    rect: { x: 1, y: 2, width: 3, height: 4 },
                    url: "javascript:alert(1)",
                },
                {
                    type: "link",
                    rect: { x: 5, y: 6, width: 7, height: 8 },
                    url: "https://example.com/",
                },
                { type: "link", rect: { x: 9, y: 10, width: 11, height: 12 }, pageNumber: 2 },
            ]),
        } as any

        await renderViewerPageLayers(paged, 1, {
            textContainer,
            annotationContainer,
            onNavigate: vi.fn(),
        })

        expect(textContainer.querySelector("span")?.textContent).toBe("Hello")
        expect(textContainer.querySelector("span")?.style.left).toBe("12px")
        expect(annotationContainer.querySelectorAll("section")).toHaveLength(2)
        expect(annotationContainer.querySelector("a[href]")?.getAttribute("href")).toBe(
            "https://example.com/",
        )
        expect(annotationContainer.querySelector("a")?.getAttribute("href")).not.toBe(
            "javascript:alert(1)",
        )
    })

    it("clears stale layers when an aborted layer load completes", async () => {
        const textContainer = globalThis.document.createElement("div")
        const annotationContainer = globalThis.document.createElement("div")
        textContainer.append(globalThis.document.createElement("span"))
        annotationContainer.append(globalThis.document.createElement("section"))
        let finish!: () => void
        const pending = new Promise<readonly any[]>((resolve) => {
            finish = () => resolve([{ text: "stale", x: 0, y: 0, width: 1, height: 1 }])
        })
        const controller = new AbortController()
        const render = renderViewerPageLayers({ getText: () => pending } as any, 1, {
            textContainer,
            annotationContainer,
            onNavigate: vi.fn(),
            signal: controller.signal,
        })
        controller.abort()
        finish()
        await render
        expect(textContainer.childElementCount).toBe(0)
        expect(annotationContainer.childElementCount).toBe(0)
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
