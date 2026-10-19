import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

const css = readFileSync(new URL("./variables.css", import.meta.url), "utf8")

type Color = { r: number; g: number; b: number }

function declarations(selector: string): Map<string, string> {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    const block = css.match(new RegExp(`${escaped}\\s*\\{([\\s\\S]*?)\\n\\}`, "m"))?.[1]
    if (!block) throw new Error(`Missing ${selector} block`)

    return new Map(
        [...block.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((match) => [match[1], match[2].trim()]),
    )
}

function hueToRgb(p: number, q: number, t: number): number {
    if (t < 0) t += 1
    if (t > 1) t -= 1
    if (t < 1 / 6) return p + (q - p) * 6 * t
    if (t < 1 / 2) return q
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6
    return p
}

function parseColor(value: string): Color {
    const hex = value.match(/^#([\da-f]{6})$/i)
    if (hex) {
        return {
            r: Number.parseInt(hex[1].slice(0, 2), 16) / 255,
            g: Number.parseInt(hex[1].slice(2, 4), 16) / 255,
            b: Number.parseInt(hex[1].slice(4, 6), 16) / 255,
        }
    }

    const hsl = value.match(/^hsl\(\s*([\d.]+)\s+([\d.]+)%\s+([\d.]+)%\s*\)$/i)
    if (!hsl) throw new Error(`Unsupported color: ${value}`)

    const h = (Number.parseFloat(hsl[1]) % 360) / 360
    const s = Number.parseFloat(hsl[2]) / 100
    const l = Number.parseFloat(hsl[3]) / 100
    if (s === 0) return { r: l, g: l, b: l }

    const q = l < 0.5 ? l * (1 + s) : l + s - l * s
    const p = 2 * l - q
    return {
        r: hueToRgb(p, q, h + 1 / 3),
        g: hueToRgb(p, q, h),
        b: hueToRgb(p, q, h - 1 / 3),
    }
}

function luminance(value: string): number {
    const channels = Object.values(parseColor(value)).map((channel) =>
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
    ["--color-on-disabled", "--color-disabled"],
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
