import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

const headerSource = readFileSync(new URL("./ViewerHeader.svelte", import.meta.url), "utf8")

describe("ViewerHeader document identity", () => {
    it("does not assume a document format", () => {
        expect(headerSource).not.toContain("PDF")
        expect(headerSource).not.toContain(".pdf")
        expect(headerSource).not.toContain("file-badge")
        expect(headerSource).toContain("{name || m.unknown_book()}")
    })

    it("keeps the document name and close action accessible", () => {
        expect(headerSource).toContain('<h1 class="file-name" title={name}>')
        expect(headerSource).toContain("aria-label={m.close_document()}")
    })

    it("keeps the scrollable document keyboard reachable", () => {
        const canvasSource = readFileSync(new URL("./CanvasPane.svelte", import.meta.url), "utf8")
        const frame = canvasSource.split('class="canvas-frame"')[1].split("bind:this")[0]
        expect(frame).toContain('role="region"')
        expect(frame).toContain('tabindex="0"')
        expect(frame).toContain("aria-label={m.viewer_reading_region()}")
    })
})
