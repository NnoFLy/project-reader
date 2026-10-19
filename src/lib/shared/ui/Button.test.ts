import { readFileSync } from "node:fs"
import { parse, type Rule } from "postcss"
import { describe, expect, it } from "vitest"

const source = readFileSync(new URL("./Button.svelte", import.meta.url), "utf8")
const styles = parse(source.split("<style>")[1].split("</style>")[0])
const tokens = parse(readFileSync(new URL("../styles/variables.css", import.meta.url), "utf8"))

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

function shadowOffset(value: string) {
    let resolved = value
    tokens.walkRules(":root", (rule: Rule) => {
        rule.walkDecls((decl) => {
            resolved = resolved.replaceAll(`var(${decl.prop})`, decl.value)
        })
    })
    const match = resolved.match(/^(-?\d+)px (-?\d+)px/)
    if (!match) throw new Error(`Expected an offset shadow, got ${resolved}`)
    return [Number(match[1]), Number(match[2])]
}

describe("Button hover shadows", () => {
    for (const variant of ["action", "brutalist"]) {
        const base = `.${variant}-btn`
        const hover = `${base}:hover:not(:disabled):not(:active):not(.active):not(.open)`

        it(`anchors the ${variant} shadow while the button lifts`, () => {
            const resting = shadowOffset(declaration(base, "box-shadow"))
            const hovered = shadowOffset(declaration(hover, "box-shadow"))
            const transform = declaration(hover, "transform")
            const translation = transform.match(/^translate\((-?\d+)px, (-?\d+)px\)$/)
            expect(translation).not.toBeNull()
            expect(hovered.map((offset, axis) => offset + Number(translation![axis + 1]))).toEqual(
                resting,
            )
        })

        it(`animates the ${variant} shadow and transform together`, () => {
            const transition = declaration(base, "transition")
            expect(transition).toContain("box-shadow 0.1s ease")
            expect(transition).toContain("transform 0.1s ease")
        })
    }
})
