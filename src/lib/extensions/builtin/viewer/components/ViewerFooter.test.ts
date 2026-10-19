import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { parse } from "svelte/compiler"

const footerSource = readFileSync(new URL("./ViewerFooter.svelte", import.meta.url), "utf8")

describe("ViewerFooter progress", () => {
    it("renders one full-width scrub bar outside responsive conditionals", () => {
        const { fragment } = parse(footerSource, { modern: true })
        const footer = fragment.nodes.find(
            (node) => node.type === "RegularElement" && node.name === "footer",
        )
        expect(footer?.type).toBe("RegularElement")
        if (footer?.type !== "RegularElement") return

        const scrubBar = footer.fragment.nodes.find(
            (node) =>
                node.type === "RegularElement" &&
                node.attributes.some(
                    (attribute) =>
                        attribute.type === "Attribute" &&
                        attribute.name === "class" &&
                        Array.isArray(attribute.value) &&
                        attribute.value.some(
                            (value) => value.type === "Text" && value.data === "footer-scrub-bar",
                        ),
                ),
        )
        expect(scrubBar).toBeDefined()
        expect(footerSource.match(/type="range"/g)).toHaveLength(1)
        expect(footerSource).not.toContain("scrubber-container")
    })

    it("anchors the visible track edge-to-edge at the top, independently of the progress fill", () => {
        const trackStyles = footerSource.match(/\.footer-scrub-bar \{([^}]+)\}/)?.[1]
        expect(trackStyles).toMatch(/top:\s*0;/)
        expect(trackStyles).toMatch(/left:\s*0;/)
        expect(trackStyles).toMatch(/right:\s*0;/)
        expect(trackStyles).toMatch(/height:\s*4px;/)
        expect(trackStyles).toMatch(/background:\s*var\(--surface-color\);/)
        expect(footerSource).toContain('style="width: {(currentPage / totalPages) * 100}%"')
    })
})
