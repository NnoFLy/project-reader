import { readFileSync } from "node:fs"
import { parse } from "postcss"
import { describe, expect, it } from "vitest"

const source = readFileSync(new URL("./Button.svelte", import.meta.url), "utf8")
const styles = parse(source.split("<style>")[1].split("</style>")[0])

function declaration(selector: string, property: string) {
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

describe("Button flat interaction states", () => {
    it("keeps surfaces and hover states free of offset shadows", () => {
        styles.walkDecls("box-shadow", (decl) => {
            expect(decl.value).toBe("none")
        })
        expect(declaration(".button:hover:not(:disabled)", "background")).toBe(
            "var(--surface-hover-color)",
        )
        expect(declaration(".button:hover:not(:disabled)", "transform")).toBe("")
    })

    it("provides visible keyboard focus without relying on a shadow", () => {
        expect(declaration(".button:focus-visible", "outline")).toBe("2px solid var(--focus-color)")
        expect(declaration(".button:focus-visible", "outline-offset")).toBe("2px")
    })

    it("reserves press feedback for enabled buttons", () => {
        expect(declaration(".button:active:not(:disabled)", "transform")).toBe("scale(0.97)")
        expect(declaration(".button", "transition")).toContain("transform 120ms ease")
        expect(declaration(".button:disabled", "color")).toBe("var(--color-on-disabled)")
        expect(declaration(".button:disabled", "cursor")).toBe("not-allowed")
    })

    it("uses one shape and prevents button labels wrapping", () => {
        expect(declaration(".button", "border-radius")).toBe("999px")
        expect(declaration(".button", "white-space")).toBe("nowrap")
        expect(declaration(".button.square", "height")).toBe("var(--button-height)")
    })
})
