import { describe, expect, it } from "vitest"
import { captureScrollAnchor, restoreScrollAnchor } from "./scrollAnchor"

function layout(width: number, ratios: number[], gap = 2) {
    const heights = ratios.map((ratio) => width * ratio)
    const offsets: number[] = []
    let offset = 0
    for (const height of heights) {
        offsets.push(offset)
        offset += height + gap
    }
    return { heights, offsets, totalHeight: offset }
}

describe("scroll-layout anchors", () => {
    it.each([
        [390, 844],
        [844, 390],
    ])("keeps a partially viewed page when resizing from %ipx to %ipx", (from, to) => {
        const ratios = [1.3, 1.5, 1.2]
        const before = layout(from, ratios)
        const after = layout(to, ratios)
        const page = 2
        const ratio = 0.37
        const viewportBefore = 700
        const scrollTop =
            before.offsets[page - 1] + before.heights[page - 1] * ratio - viewportBefore / 2
        const anchor = captureScrollAnchor(
            page,
            scrollTop,
            viewportBefore,
            before.offsets,
            before.heights,
        )

        expect(anchor).not.toBeNull()
        const restored = restoreScrollAnchor(
            anchor!,
            360,
            after.offsets,
            after.heights,
            after.totalHeight - 360,
        )
        expect((restored + 180 - after.offsets[page - 1]) / after.heights[page - 1]).toBeCloseTo(
            ratio,
        )
    })

    it("clamps restoration at the first and last page bounds", () => {
        const geometry = layout(400, [1.4, 1.4, 1.4])
        expect(
            restoreScrollAnchor(
                { page: 1, offsetRatio: 0 },
                700,
                geometry.offsets,
                geometry.heights,
                geometry.totalHeight - 700,
            ),
        ).toBe(0)
        expect(
            restoreScrollAnchor(
                { page: 3, offsetRatio: 1 },
                700,
                geometry.offsets,
                geometry.heights,
                geometry.totalHeight - 700,
            ),
        ).toBe(geometry.totalHeight - 700)
    })
})
