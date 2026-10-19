import { readFileSync } from "node:fs"
import { parse } from "postcss"
import { describe, expect, it } from "vitest"

const source = readFileSync(new URL("./Modal.svelte", import.meta.url), "utf8")
const styles = parse(source.split("<style>")[1].split("</style>")[0])

function declaration(selector: string, property: string) {
    let value = ""
    styles.walkRules((rule) => {
        if (rule.selector === selector) {
            rule.walkDecls(property, (decl) => {
                value = decl.value
            })
        }
    })
    return value
}

describe("Modal danger confirmation button", () => {
    const selector = ".confirmation-actions :global(.confirmation-danger:not(:disabled))"

    it("pairs the danger label with a visible danger background without hovering", () => {
        expect(declaration(selector, "background")).toBe("var(--danger-color)")
        expect(declaration(selector, "color")).toBe("var(--danger-text-color)")
    })

    it("keeps danger contrast on hover without overriding disabled buttons", () => {
        expect(
            declaration(
                ".confirmation-actions :global(.confirmation-danger:hover:not(:disabled))",
                "background",
            ),
        ).toBe("var(--danger-active-color)")
        expect(declaration(":global(.confirmation-danger)", "--btn-text")).toBe("")
    })
})
