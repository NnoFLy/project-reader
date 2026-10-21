import { readFileSync } from "node:fs"
import { parse } from "postcss"
import { describe, expect, it } from "vitest"

const source = readFileSync(new URL("./Spinner.svelte", import.meta.url), "utf8")
const styles = parse(source.split("<style>")[1].split("</style>")[0])

describe("Spinner CSS motion", () => {
    it("introduces each variant with finite animation, then returns to static artwork", () => {
        const animatedSelectors: string[] = []
        styles.walkDecls("animation", (decl) => {
            expect(decl.value).not.toMatch(/infinite|forwards|both/)
            expect(decl.value).toContain("var(--spinner-duration)")
            if (decl.parent?.type === "rule") animatedSelectors.push(decl.parent.selector)
        })
        expect(animatedSelectors).toEqual([
            ".spinner-element.classic",
            ".square-outer",
            ".square-inner",
            ".dot",
        ])
    })

    it("retains every speed and stepped option", () => {
        const rules = new Map<string, string>()
        styles.walkRules((rule) => {
            rules.set(rule.selector, rule.toString())
        })
        for (const speed of ["slow", "normal", "fast"]) {
            expect(rules.get(`.spinner-element.speed-${speed}`)).toContain(`var(--speed-${speed})`)
        }
        expect(rules.get(".spinner-element.stepped")).toContain("steps(8)")
    })
})
