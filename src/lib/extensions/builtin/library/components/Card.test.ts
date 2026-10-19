import { readFileSync } from "node:fs"
import { parse, type Root } from "postcss"
import { describe, expect, it } from "vitest"

function readStyles(file: string) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8")
    return parse(source.split("<style>")[1].split("</style>")[0])
}

function declaration(styles: Root, selector: string, property: string) {
    let value = ""
    styles.walkRules(selector, (rule) => {
        rule.walkDecls(property, (decl) => {
            value = decl.value
        })
    })
    return value
}

const tokens = parse(
    readFileSync(new URL("../../../../shared/styles/variables.css", import.meta.url), "utf8"),
)

function shadowOffset(value: string) {
    let resolved = value
    tokens.walkRules(":root", (rule) => {
        rule.walkDecls((decl) => {
            resolved = resolved.replaceAll(`var(${decl.prop})`, decl.value)
        })
    })
    const match = resolved.match(/^\s*(-?\d+)px (-?\d+)px/)
    if (!match) throw new Error(`Expected an offset shadow, got ${resolved}`)
    return [Number(match[1]), Number(match[2])]
}

const bookHover = ".card:hover:not(.is-placeholder)"
const bookFocus = ".card:focus-visible:not(.is-placeholder)"

describe("Card shadow anchoring", () => {
    it.each([
        ["Card.svelte", ".card", bookHover, bookHover],
        [
            "Card.svelte",
            ".card.is-selected",
            ".card.is-selected:hover:not(.is-placeholder)",
            bookHover,
        ],
        ["Card.svelte", ".card", bookFocus, bookFocus],
        [
            "Card.svelte",
            ".card.is-selected",
            ".card.is-selected:focus-visible:not(.is-placeholder)",
            bookFocus,
        ],
        ["Folder.svelte", ".card", ".card:hover", ".card:hover"],
        ["Folder.svelte", ".card", ".card:focus-visible", ".card:focus-visible"],
        [
            "BookImporter.svelte",
            ".card",
            ".card:hover:not(:disabled)",
            ".card:hover:not(:disabled)",
        ],
        [
            "BookImporter.svelte",
            ".card",
            ".card:focus-visible:not(:disabled)",
            ".card:focus-visible:not(:disabled)",
        ],
        ["BookImporter.svelte", ".card", ".card.drag-active", ".card.drag-active"],
        [
            "BookImporter.svelte",
            ".reader-card",
            ".reader-card.drag-active",
            ".reader-card.drag-active",
        ],
    ])("%s keeps %s anchored in %s", (file, base, state, motionState) => {
        const styles = readStyles(file)
        const resting = shadowOffset(declaration(styles, base, "box-shadow"))
        const moved = shadowOffset(declaration(styles, state, "box-shadow"))
        const transform = declaration(styles, motionState, "transform")
        const translation =
            transform === "none"
                ? [0, 0]
                : transform
                      .match(/^translate\((-?\d+)px, (-?\d+)px\)$/)
                      ?.slice(1)
                      .map(Number)

        expect(translation).toBeDefined()
        expect(moved.map((offset, axis) => offset + translation![axis])).toEqual(resting)
    })
})
