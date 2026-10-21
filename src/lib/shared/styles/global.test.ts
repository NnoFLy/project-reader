import { readFileSync } from "node:fs"
import { parse } from "postcss"
import { describe, expect, it } from "vitest"

const styles = parse(readFileSync(new URL("./global.css", import.meta.url), "utf8"))

describe("global motion guards", () => {
    it.each(['html[data-motion="off"]', 'html:not([data-motion="on"])'])(
        "disables animation for %s without blocking modal movement",
        (rootSelector) => {
            let found = false
            styles.walkRules((rule) => {
                if (!rule.selectors.includes(`${rootSelector} *:not([data-modal-movement="true"])`))
                    return
                found = true
                expect(rule.selectors).toContain(`${rootSelector} *::before`)
                expect(rule.selectors).toContain(`${rootSelector} *::after`)
                const declarations = new Map<string, string>()
                rule.walkDecls((decl) => {
                    expect(decl.important).toBe(true)
                    declarations.set(decl.prop, decl.value)
                })
                expect(declarations.get("animation")).toBe("none")
                expect(declarations.get("scroll-behavior")).toBe("auto")
                expect(declarations.get("transition-duration")).toBe("0.001ms")
                if (rootSelector.includes(":not")) {
                    expect(rule.parent?.type).toBe("atrule")
                    expect(rule.parent).toHaveProperty("params", "(prefers-reduced-motion: reduce)")
                }
            })
            expect(found).toBe(true)
        },
    )
})
