import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

const previewSource = readFileSync(new URL("./PageBitmapPreview.svelte", import.meta.url), "utf8")
const canvasSource = readFileSync(new URL("./CanvasPane.svelte", import.meta.url), "utf8")

function cssBlock(source: string, selector: string) {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    return source.match(new RegExp(`(?:^|\\n)\\s*${escaped}\\s*\\{([^}]+)\\}`))?.[1] ?? ""
}

describe("PageBitmapPreview lifecycle contract", () => {
    it("is bitmap-only and does not construct active viewer behavior", () => {
        expect(previewSource).not.toContain("PDFDocument")
        expect(previewSource).not.toContain("useCommands")
        expect(previewSource).not.toContain("viewerStore")
        expect(previewSource).not.toContain("document.addEventListener")
        expect(previewSource).not.toContain("getPageDimension")
        expect(previewSource).not.toContain("textLayer")
        expect(previewSource).not.toContain("annotationLayer")
        expect(previewSource).toContain("currentPageDim1")
        expect(previewSource).toContain("currentPageImage")
        expect(previewSource).toContain('isCompactPortrait && "compact-portrait"')
    })

    it("matches active compact-landscape borders, shadows, and gaps", () => {
        const presentationDeclarations = [
            [".pdf-image-wrapper", "border:"],
            [".pdf-image-wrapper", "box-shadow:"],
            [".pages-container.split-mode", "gap:"],
            [".book-spread", "border:"],
            [".book-spread", "box-shadow:"],
        ] as const

        for (const [selector, declaration] of presentationDeclarations) {
            const active = cssBlock(canvasSource, selector)
                .split("\n")
                .find((line) => line.trim().startsWith(declaration))
                ?.trim()
            const preview = cssBlock(previewSource, selector)
                .split("\n")
                .find((line) => line.trim().startsWith(declaration))
                ?.trim()
            expect(preview, `${selector} ${declaration}`).toBe(active)
        }

        const activeCompactRules = canvasSource.slice(canvasSource.indexOf("@media (--desktop)"))
        const previewCompactRules = previewSource.slice(previewSource.indexOf("@media (--desktop)"))
        expect(activeCompactRules).toContain("gap: 16px")
        expect(previewCompactRules).toContain("gap: 16px")
        expect(previewSource).toContain(".preview-frame.compact-portrait .book-spread")
        expect(previewSource).toContain(".preview-frame.compact-portrait .pdf-image-wrapper")
        expect(cssBlock(previewSource, ".pdf-image-wrapper")).not.toContain("max-width")
        expect(cssBlock(previewSource, ".book-spread")).not.toContain("max-width")
    })
})
