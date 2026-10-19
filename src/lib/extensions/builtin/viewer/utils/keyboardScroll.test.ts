// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createKeyboardScroller } from "./keyboardScroll"

let callbacks: Map<number, FrameRequestCallback>
let nextFrame: number
let container: HTMLDivElement
let scroller: ReturnType<typeof createKeyboardScroller>

function tick(time: number) {
    const pending = [...callbacks.values()]
    callbacks.clear()
    for (const callback of pending) callback(time)
}

beforeEach(() => {
    callbacks = new Map()
    nextFrame = 0
    vi.spyOn(performance, "now").mockReturnValue(0)
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
        callbacks.set(++nextFrame, callback)
        return nextFrame
    })
    vi.stubGlobal("cancelAnimationFrame", (id: number) => callbacks.delete(id))
    // Native smooth scrolling is unavailable, as it can be with OS animations disabled.
    container = document.createElement("div")
    Object.defineProperties(container, {
        clientHeight: { value: 400 },
        scrollHeight: { value: 2000 },
    })
    container.scrollTo = vi.fn((options?: ScrollToOptions | number, y?: number) => {
        if (typeof options === "number") {
            container.scrollTop = y ?? container.scrollTop
        } else {
            if (options?.behavior === "smooth") throw new Error("Native smooth scrolling disabled")
            container.scrollTop = options?.top ?? container.scrollTop
        }
    })
    scroller = createKeyboardScroller()
})

afterEach(() => {
    scroller.cancel()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
})

describe("reader keyboard scrolling", () => {
    it("animates over multiple frames without native smooth scrolling", () => {
        scroller.scrollBy(container, 400, true)
        expect(container.scrollTop).toBe(0)
        tick(60)
        expect(container.scrollTop).toBeGreaterThan(0)
        expect(container.scrollTop).toBeLessThan(400)
        tick(120)
        expect(container.scrollTop).toBeGreaterThan(300)
        tick(180)
        expect(container.scrollTop).toBe(400)
        expect(callbacks.size).toBe(0)
    })

    it("smoothly traverses a full PDF page using the longer navigation duration", () => {
        scroller.scrollBy(container, 1500, true, 500)
        tick(180)
        expect(container.scrollTop).toBeGreaterThan(0)
        expect(container.scrollTop).toBeLessThan(1500)
        expect(scroller.isScrolling).toBe(true)
        tick(500)
        expect(container.scrollTop).toBe(1500)
        expect(scroller.isScrolling).toBe(false)
    })

    it("lets keyboard steps interrupt page navigation on the same pane", () => {
        scroller.scrollBy(container, 1500, true, 500)
        tick(60)
        const position = container.scrollTop
        const stepScroller = createKeyboardScroller()
        stepScroller.scrollBy(container, 100, false)
        tick(500)
        expect(container.scrollTop).toBe(position + 100)
        expect(scroller.isScrolling).toBe(false)
    })

    it("scrolls immediately when animations are off or a key is repeating", () => {
        scroller.scrollBy(container, 200, false)
        expect(container.scrollTop).toBe(200)
        expect(callbacks.size).toBe(0)
    })

    it("cancels an animation before a repeated key scrolls immediately", () => {
        scroller.scrollBy(container, 400, true)
        tick(60)
        const position = container.scrollTop
        scroller.scrollBy(container, 200, false)
        expect(container.scrollTop).toBe(position + 200)
        tick(180)
        expect(container.scrollTop).toBe(position + 200)
    })

    it.each(["wheel", "touchstart", "pointerdown"])("stops on %s input", (event) => {
        scroller.scrollBy(container, 400, true)
        tick(60)
        const position = container.scrollTop
        container.dispatchEvent(new Event(event))
        tick(180)
        expect(container.scrollTop).toBe(position)
        expect(callbacks.size).toBe(0)
    })

    it("clamps scrolling in both directions to the content bounds", () => {
        container.scrollTop = 1500
        scroller.scrollBy(container, 400, true)
        tick(180)
        expect(container.scrollTop).toBe(1600)
        scroller.scrollBy(container, -2000, true)
        tick(180)
        expect(container.scrollTop).toBe(0)
    })

    it("cancels pending frames when the reader is disposed", () => {
        scroller.scrollBy(container, 400, true)
        scroller.cancel()
        tick(180)
        expect(container.scrollTop).toBe(0)
        expect(callbacks.size).toBe(0)
    })
})
