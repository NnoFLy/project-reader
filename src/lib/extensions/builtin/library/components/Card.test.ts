import { readFileSync } from "node:fs"
import { parse, type Root } from "postcss"
import { describe, expect, it } from "vitest"

function readStyles(file: string) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8")
    return parse(source.split("<style>")[1].split("</style>")[0])
}

function declaration(styles: Root, selector: string, property: string) {
    let value = ""
    styles.walkRules((rule) => {
        if (rule.selector.split(",").some((item) => item.trim() === selector)) {
            rule.walkDecls(property, (decl) => {
                value = decl.value
            })
        }
    })
    return value
}

describe("Library reading surfaces", () => {
    it.each(["Card.svelte", "BookImporter.svelte"])(
        "%s keeps its resting and interaction surfaces flat",
        (file) => {
            const styles = readStyles(file)
            styles.walkDecls("box-shadow", (decl) => {
                expect(decl.value).toBe("none")
            })
            styles.walkDecls("transform", (decl) => {
                expect(decl.value).not.toContain("translate")
            })
            expect(declaration(styles, ".card", "background")).toBe("var(--surface-color)")
        },
    )

    it("distinguishes selected books and keyboard focus independently", () => {
        const styles = readStyles("Card.svelte")
        expect(declaration(styles, ".card.is-selected", "border-color")).toBe(
            "var(--selection-color)",
        )
        expect(declaration(styles, ".card.is-selected", "background")).toBe(
            "var(--selected-surface)",
        )
        expect(declaration(styles, ".card:focus-visible:not(.is-placeholder)", "outline")).toBe(
            "2px solid var(--focus-color)",
        )
    })

    it("puts progress on a thin data mark without coloring its label", () => {
        const styles = readStyles("Card.svelte")
        expect(declaration(styles, ".progress-bar-fill", "height")).toBe("3px")
        expect(declaration(styles, ".progress-bar-fill", "background")).toBe(
            "var(--progress-color)",
        )
        expect(declaration(styles, ".progress-text", "color")).toBe("var(--faded-text-color)")
        expect(declaration(styles, ".progress-text", "font-variant-numeric")).toBe("tabular-nums")
        // The mobile progress mark is a child of the clipped cover.
        expect(declaration(styles, ".progress-container", "left")).toBe("0")
        expect(declaration(styles, ".progress-container", "width")).toBe("100%")
    })

    it("keeps the loading indicator readable on its unfilled icon surface", () => {
        const source = readFileSync(new URL("./BookImporter.svelte", import.meta.url), "utf8")
        const icon = source.split('<div class="upload-icon-wrapper"')[1].split("</div>")[0]
        expect(icon).toContain("--danger-active-color: var(--text-color)")
        expect(icon).not.toContain("--danger-active-color: var(--primary-text-color)")
    })

    it("shows drag and keyboard focus without continuous animation", () => {
        const styles = readStyles("BookImporter.svelte")
        expect(declaration(styles, ".reader-card.drag-active", "outline")).toBe(
            "2px solid var(--focus-color)",
        )
        expect(declaration(styles, ".card:focus-visible", "outline")).toBe(
            "2px solid var(--focus-color)",
        )
        styles.walkDecls("animation", (decl) => {
            expect(decl.value).not.toContain("infinite")
        })
    })
})
