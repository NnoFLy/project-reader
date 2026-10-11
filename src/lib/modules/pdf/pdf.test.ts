import { afterEach, describe, expect, it, vi } from "vitest"
import PDFDocument, {
    Page,
    PDF_RESOURCE_LIMITS,
    PDFResourceLimitError,
    assertPdfFileSize,
} from "./pdf"

type DeferredRender = {
    promise: Promise<void>
    resolve: () => void
}

function deferredRender(): DeferredRender {
    let resolve!: () => void
    const promise = new Promise<void>((done) => {
        resolve = done
    })
    return { promise, resolve }
}

function createRenderHarness(renderForQuality?: (quality: number) => DeferredRender) {
    const pdf = new PDFDocument("test.pdf")
    const renders: number[] = []
    const createdUrls: string[] = []
    const revokedUrls: string[] = []

    const pageProxy = {
        getViewport: ({ scale }: { scale: number }) => ({
            width: 100 * scale,
            height: 200 * scale,
            scale,
        }),
        render: ({ viewport }: { viewport: { scale: number } }) => {
            renders.push(viewport.scale)
            const render = renderForQuality?.(viewport.scale)
            return {
                promise: render?.promise ?? Promise.resolve(),
                cancel: vi.fn(),
            }
        },
        cleanup: vi.fn(),
    }

    Object.assign(pdf as object, {
        pdfDoc: {
            getPage: vi.fn().mockResolvedValue(pageProxy),
        },
    })

    vi.stubGlobal("window", { devicePixelRatio: 1 })
    vi.stubGlobal("document", {
        createElement: vi.fn(() => ({
            width: 0,
            height: 0,
            style: {},
            getContext: () => ({
                imageSmoothingEnabled: false,
                imageSmoothingQuality: "low",
            }),
            toBlob: (callback: (blob: Blob) => void) => callback(new Blob(["page"])),
        })),
    })
    vi.stubGlobal("URL", {
        createObjectURL: vi.fn(() => {
            const url = `blob:page-${createdUrls.length + 1}`
            createdUrls.push(url)
            return url
        }),
        revokeObjectURL: vi.fn((url: string) => revokedUrls.push(url)),
    })

    return { pdf, renders, createdUrls, revokedUrls }
}

afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
})

describe("PDF resource limits", () => {
    it("rejects files above the byte limit", () => {
        expect(() => assertPdfFileSize(PDF_RESOURCE_LIMITS.maxFileBytes + 1)).toThrow("byte limit")
        expect(() => assertPdfFileSize(PDF_RESOURCE_LIMITS.maxFileBytes)).not.toThrow()
    })

    it("rejects dimension scans for documents above the page limit", async () => {
        const pdf = Object.create(PDFDocument.prototype) as PDFDocument
        Object.defineProperty(pdf, "pageCount", {
            value: PDF_RESOURCE_LIMITS.maxPages + 1,
            writable: true,
        })

        await expect(pdf.getAllPageDimensions()).rejects.toThrow("page limit")
    })

    it("rejects pages above the dimension limit", async () => {
        const pdf = Object.create(PDFDocument.prototype) as PDFDocument
        Object.assign(pdf as object, {
            pageDimensionsCache: new Map(),
            pdfDoc: {
                getPage: vi.fn().mockResolvedValue({
                    getViewport: () => ({
                        width: PDF_RESOURCE_LIMITS.maxPageDimension + 1,
                        height: 1,
                    }),
                    cleanup: vi.fn(),
                }),
            },
        })

        await expect(pdf.getPageDimension(1, true)).rejects.toThrow("dimension limit")
    })

    it("rejects canvases above the pixel limit", async () => {
        const { pdf } = createRenderHarness()
        Object.assign(pdf as object, {
            pdfDoc: {
                getPage: vi.fn().mockResolvedValue({
                    getViewport: () => ({
                        width: PDF_RESOURCE_LIMITS.maxPageDimension,
                        height:
                            Math.ceil(
                                PDF_RESOURCE_LIMITS.maxCanvasPixels /
                                    PDF_RESOURCE_LIMITS.maxPageDimension,
                            ) + 1,
                    }),
                    cleanup: vi.fn(),
                }),
            },
        })

        await expect(pdf.getCanvasPage(new Page(1), 1)).rejects.toBeInstanceOf(
            PDFResourceLimitError,
        )
    })

    it("rejects oversized page dimensions from viewer layer rendering", async () => {
        const pdf = Object.create(PDFDocument.prototype) as PDFDocument
        const pageProxy = {
            getTextContent: vi.fn().mockResolvedValue({ items: [] }),
            getAnnotations: vi.fn().mockResolvedValue([]),
            getViewport: vi.fn(() => ({
                width: PDF_RESOURCE_LIMITS.maxPageDimension + 1,
                height: 100,
            })),
            cleanup: vi.fn(),
        }
        Object.assign(pdf as object, {
            pageProxyCache: new Map(),
            pageProxyPromises: new Map(),
            pdfDoc: { getPage: vi.fn().mockResolvedValue(pageProxy) },
        })

        await expect(pdf.getPageDataForRendering(2, 1)).rejects.toThrow("dimension limit")
    })
})

describe("PDFDocument dimension scanning", () => {
    it("does not request later chunks after abort", async () => {
        const controller = new AbortController()
        const pdf = Object.create(PDFDocument.prototype) as PDFDocument
        Object.defineProperty(pdf, "pageCount", { value: 20, writable: true })
        const getPageDimension = vi
            .spyOn(pdf, "getPageDimension")
            .mockImplementation(async (pageNumber) => {
                if (pageNumber === 1) controller.abort()
                return { width: 600, height: 800 }
            })

        await expect(pdf.getAllPageDimensions(controller.signal)).rejects.toMatchObject({
            name: "AbortError",
        })
        expect(getPageDimension).toHaveBeenCalledTimes(1)
    })
})

describe("PDFDocument bitmap cache", () => {
    it("returns the cached URL for the same page and render quality", async () => {
        const { pdf, renders } = createRenderHarness()

        const first = await pdf.getCanvasPage(new Page(1), 2)
        const second = await pdf.getCanvasPage(new Page(1), 2)

        expect(second).toBe(first)
        expect(renders).toEqual([2])
    })

    it("does not include display scale in the bitmap cache contract", async () => {
        const { pdf, renders } = createRenderHarness()
        const displayScales = [0.75, 1, 1.8]

        const urls: string[] = []
        for (const _displayScale of displayScales) {
            urls.push(await pdf.getCanvasPage(new Page(1), 2))
        }

        expect(new Set(urls)).toEqual(new Set([urls[0]]))
        expect(renders).toEqual([2])
    })

    it("invalidates and revokes old URLs when render quality changes", async () => {
        const { pdf, renders, revokedUrls } = createRenderHarness()

        const oldUrl = await pdf.getCanvasPage(new Page(1), 1)
        const newUrl = await pdf.getCanvasPage(new Page(1), 2)

        expect(newUrl).not.toBe(oldUrl)
        expect(renders).toEqual([1, 2])
        expect(revokedUrls).toContain(oldUrl)
    })

    it("revokes the least-recently-used URL when the cache is full", async () => {
        const { pdf, revokedUrls } = createRenderHarness()
        Object.assign(pdf as object, { isMobile: true })

        const firstUrl = await pdf.getCanvasPage(new Page(1), 2)
        for (let pageNumber = 2; pageNumber <= 9; pageNumber += 1) {
            await pdf.getCanvasPage(new Page(pageNumber), 2)
        }

        expect(revokedUrls).toContain(firstUrl)
    })

    it("revokes the losing blob URL when concurrent same-page renders publish", async () => {
        const pending: DeferredRender[] = []
        const { pdf, createdUrls, revokedUrls } = createRenderHarness(() => {
            const render = deferredRender()
            pending.push(render)
            return render
        })

        const firstRender = pdf.getCanvasPage(new Page(1), 2)
        const secondRender = pdf.getCanvasPage(new Page(1), 2)
        await vi.waitFor(() => expect(pending).toHaveLength(2))

        pending[0].resolve()
        const winner = await firstRender
        pending[1].resolve()
        const loserResult = await secondRender

        expect(loserResult).toBe(winner)
        expect(createdUrls).toHaveLength(2)
        expect(revokedUrls).toContain(createdUrls[1])
        expect(revokedUrls).not.toContain(winner)
    })

    it("prevents an obsolete quality render from repopulating the active cache", async () => {
        const pending = new Map<number, DeferredRender>()
        const { pdf, renders } = createRenderHarness((quality) => {
            const render = deferredRender()
            pending.set(quality, render)
            return render
        })

        const oldRender = pdf.getCanvasPage(new Page(1), 1)
        await vi.waitFor(() => expect(pending.has(1)).toBe(true))

        const newRender = pdf.getCanvasPage(new Page(1), 2)
        await vi.waitFor(() => expect(pending.has(2)).toBe(true))
        pending.get(2)!.resolve()
        const newUrl = await newRender

        pending.get(1)!.resolve()
        await expect(oldRender).rejects.toMatchObject({ name: "AbortError" })

        expect(await pdf.getCanvasPage(new Page(1), 2)).toBe(newUrl)
        expect(renders).toEqual([1, 2])
    })
})
