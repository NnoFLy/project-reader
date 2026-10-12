import { describe, expect, it } from "vitest"
import { getBitmapPageScale, getBitmapWrapperStyle } from "./pageBitmapGeometry"

const portrait = { width: 600, height: 900 }
const landscape = { width: 900, height: 600 }

describe("page bitmap geometry", () => {
    it("fits a compact single page to the available width", () => {
        expect(
            getBitmapPageScale({
                containerWidth: 300,
                dimension: portrait,
                layout: "single",
                effectiveScale: 1,
                defaultScale: 1,
                compact: true,
            }),
        ).toBe(0.5)
    })

    it("fits unequal split pages with one shared scale", () => {
        const leftScale = getBitmapPageScale({
            containerWidth: 750,
            dimension: portrait,
            otherDimension: landscape,
            layout: "split",
            effectiveScale: 1,
            defaultScale: 1,
            compact: true,
        })
        const rightScale = getBitmapPageScale({
            containerWidth: 750,
            dimension: landscape,
            otherDimension: portrait,
            layout: "split",
            effectiveScale: 1,
            defaultScale: 1,
            compact: true,
        })

        expect(leftScale).toBe(0.5)
        expect(rightScale).toBe(0.5)
        expect(getBitmapWrapperStyle(portrait, leftScale)).toContain("width: 300px")
        expect(getBitmapWrapperStyle(landscape, rightScale)).toContain("height: 300px")
    })

    it("preserves the configured scale outside compact layout", () => {
        expect(
            getBitmapPageScale({
                containerWidth: 300,
                dimension: portrait,
                layout: "single",
                effectiveScale: 1.75,
                defaultScale: 1,
                compact: false,
            }),
        ).toBe(1.75)
    })

    it("allows compact landscape previews to exceed the viewport at a larger scale", () => {
        const scale = getBitmapPageScale({
            containerWidth: 300,
            dimension: portrait,
            layout: "single",
            effectiveScale: 1.5,
            defaultScale: 1,
            compact: true,
        })

        expect(scale).toBe(0.75)
        expect(getBitmapWrapperStyle(portrait, scale)).toContain("width: 450px")
    })
})
