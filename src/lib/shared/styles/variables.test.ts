import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

const css = readFileSync(new URL("./variables.css", import.meta.url), "utf8")

function declarations(selector: string): Map<string, string> {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    const block = css.match(new RegExp(`${escaped}\\s*\\{([\\s\\S]*?)\\n\\}`, "m"))?.[1]
    if (!block) throw new Error(`Missing ${selector} block`)

    return new Map(
        [...block.matchAll(/(--[\w-]+):\s*(#[\da-f]{6})\s*;/gi)].map((match) => [
            match[1],
            match[2],
        ]),
    )
}

function luminance(hex: string): number {
    const channels = hex
        .slice(1)
        .match(/.{2}/g)!
        .map((channel) => Number.parseInt(channel, 16) / 255)
        .map((channel) =>
            channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
        )
    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2]
}

function contrast(foreground: string, background: string): number {
    const [lighter, darker] = [luminance(foreground), luminance(background)].sort((a, b) => b - a)
    return (lighter + 0.05) / (darker + 0.05)
}

const textPairs = [
    ["--color-text", "--color-canvas"],
    ["--color-text", "--color-surface"],
    ["--color-text-muted", "--color-surface"],
    ["--color-on-action", "--color-action"],
    ["--color-on-marker", "--color-marker"],
    ["--color-on-danger", "--color-danger"],
] as const

const boundaryPairs = [
    ["--color-control-border", "--color-surface"],
    ["--color-focus", "--color-surface"],
] as const

describe.each([":root", ":global(html.dark)"])("%s semantic contrast", (selector) => {
    const tokens = declarations(selector)

    it.each(textPairs)("keeps %s readable on %s", (foreground, background) => {
        expect(contrast(tokens.get(foreground)!, tokens.get(background)!)).toBeGreaterThanOrEqual(
            4.5,
        )
    })

    it.each(boundaryPairs)("keeps %s distinguishable on %s", (foreground, background) => {
        expect(contrast(tokens.get(foreground)!, tokens.get(background)!)).toBeGreaterThanOrEqual(3)
    })
})
