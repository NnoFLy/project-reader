import { describe, expect, it, vi } from "vitest"
import {
    createPageRenderPlan,
    executePageRenderPlan,
    getPageTarget,
    getSpreadPages,
} from "./pageSliderPolicy"

describe("page slider targets", () => {
    it("moves one page at a time in single layout", () => {
        expect(getPageTarget(1, 10, "single", "previous")).toBeUndefined()
        expect(getPageTarget(1, 10, "single", "next")).toBe(2)
        expect(getPageTarget(10, 10, "single", "next")).toBeUndefined()
    })

    it("does not advance from a split spread that already contains the final page", () => {
        expect(getPageTarget(9, 10, "split", "next")).toBeUndefined()
        expect(getSpreadPages(9, 10, "split")).toEqual([9, 10])
    })

    it("keeps an odd final page reachable as a singleton split spread", () => {
        expect(getPageTarget(7, 9, "split", "next")).toBe(9)
        expect(getSpreadPages(9, 9, "split")).toEqual([9])
        expect(getPageTarget(9, 9, "split", "next")).toBeUndefined()
    })

    it("bounds previous split targets without wrapping", () => {
        expect(getPageTarget(2, 10, "split", "previous")).toBe(1)
        expect(getPageTarget(3, 10, "split", "previous")).toBe(1)
        expect(getPageTarget(1, 10, "split", "previous")).toBeUndefined()
    })
})

describe("page bitmap render plan", () => {
    it("contains unique, bounded single-page work", () => {
        const plan = createPageRenderPlan({
            currentPage: 5,
            totalPages: 10,
            layout: "single",
            includeAdjacent: true,
        })

        expect(plan).toEqual([
            { pageNumber: 5, roles: ["current"] },
            { pageNumber: 4, roles: ["previous"] },
            { pageNumber: 6, roles: ["next"] },
            { pageNumber: 7, roles: ["lookahead"] },
        ])
        expect(new Set(plan.map((entry) => entry.pageNumber)).size).toBe(plan.length)
    })

    it("does not submit split neighbors again as look-ahead work", () => {
        const plan = createPageRenderPlan({
            currentPage: 5,
            totalPages: 12,
            layout: "split",
            includeAdjacent: true,
        })

        expect(plan).toEqual([
            { pageNumber: 5, roles: ["current"] },
            { pageNumber: 6, roles: ["current"] },
            { pageNumber: 3, roles: ["previous"] },
            { pageNumber: 4, roles: ["previous"] },
            { pageNumber: 7, roles: ["next"] },
            { pageNumber: 8, roles: ["next"] },
            { pageNumber: 9, roles: ["lookahead"] },
            { pageNumber: 10, roles: ["lookahead"] },
        ])
        expect(new Set(plan.map((entry) => entry.pageNumber)).size).toBe(plan.length)
    })

    it("retains every role for overlapping split spreads without duplicate work", () => {
        const plan = createPageRenderPlan({
            currentPage: 2,
            totalPages: 10,
            layout: "split",
            includeAdjacent: true,
        })

        expect(plan).toEqual([
            { pageNumber: 2, roles: ["current", "previous"] },
            { pageNumber: 3, roles: ["current"] },
            { pageNumber: 1, roles: ["previous"] },
            { pageNumber: 4, roles: ["next"] },
            { pageNumber: 5, roles: ["next"] },
            { pageNumber: 6, roles: ["lookahead"] },
            { pageNumber: 7, roles: ["lookahead"] },
        ])
        expect(new Set(plan.map((entry) => entry.pageNumber)).size).toBe(plan.length)
    })

    it("warms the immediate next page when adjacent publication is disabled", () => {
        expect(
            createPageRenderPlan({
                currentPage: 5,
                totalPages: 10,
                layout: "single",
                includeAdjacent: false,
            }),
        ).toEqual([
            { pageNumber: 5, roles: ["current"] },
            { pageNumber: 6, roles: ["lookahead"] },
        ])
    })

    it("warms the immediate next spread when adjacent publication is disabled", () => {
        expect(
            createPageRenderPlan({
                currentPage: 5,
                totalPages: 10,
                layout: "split",
                includeAdjacent: false,
            }),
        ).toEqual([
            { pageNumber: 5, roles: ["current"] },
            { pageNumber: 6, roles: ["current"] },
            { pageNumber: 7, roles: ["lookahead"] },
            { pageNumber: 8, roles: ["lookahead"] },
        ])
    })

    it("never includes out-of-range pages near the document end", () => {
        const plan = createPageRenderPlan({
            currentPage: 9,
            totalPages: 10,
            layout: "split",
            includeAdjacent: true,
        })

        expect(plan.every((entry) => entry.pageNumber >= 1 && entry.pageNumber <= 10)).toBe(true)
        expect(plan.filter((entry) => entry.roles.includes("next"))).toEqual([])
    })

    it("reuses an overlapping render for every referencing role", async () => {
        const controller = new AbortController()
        const plan = createPageRenderPlan({
            currentPage: 2,
            totalPages: 10,
            layout: "split",
            includeAdjacent: true,
        })
        const render = vi.fn(async (pageNumber: number) => `page-${pageNumber}`)
        const publish = vi.fn()

        await executePageRenderPlan({ plan, signal: controller.signal, render, publish })

        expect(render.mock.calls.filter(([pageNumber]) => pageNumber === 2)).toHaveLength(1)
        expect(publish).toHaveBeenCalledWith("current", ["page-2", "page-3"])
        expect(publish).toHaveBeenCalledWith("previous", ["page-1", "page-2"])
    })

    it("submits every page once and suppresses stale publications", async () => {
        const controller = new AbortController()
        const plan = createPageRenderPlan({
            currentPage: 3,
            totalPages: 8,
            layout: "single",
            includeAdjacent: true,
        })
        const render = vi.fn(async (pageNumber: number) => {
            if (pageNumber === 2) controller.abort()
            return `page-${pageNumber}`
        })
        const publish = vi.fn()

        await executePageRenderPlan({ plan, signal: controller.signal, render, publish })

        expect(render.mock.calls.map(([pageNumber]) => pageNumber)).toEqual([3, 2])
        expect(new Set(render.mock.calls.map(([pageNumber]) => pageNumber)).size).toBe(
            render.mock.calls.length,
        )
        expect(publish).toHaveBeenCalledTimes(1)
        expect(publish).toHaveBeenCalledWith("current", ["page-3"])
    })
})
