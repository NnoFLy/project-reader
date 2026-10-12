import { describe, expect, it, vi } from "vitest"
import { RelinkRequestState } from "./relinkRequest.svelte"

describe("RelinkRequestState", () => {
    it("opens and cancels a request without retrying", () => {
        const state = new RelinkRequestState()
        const complete = vi.fn()
        state.request("book", complete)
        expect(state.nodeId).toBe("book")
        state.cancel()
        expect(state.nodeId).toBeNull()
        expect(complete).not.toHaveBeenCalled()
    })

    it("clears before completing and retries exactly once", async () => {
        const state = new RelinkRequestState()
        const complete = vi.fn()
        state.request("book", complete)
        await state.complete()
        await state.complete()
        expect(state.nodeId).toBeNull()
        expect(complete).toHaveBeenCalledOnce()
    })

    it("keeps instances independent", () => {
        const first = new RelinkRequestState()
        const second = new RelinkRequestState()
        first.request("book")
        expect(second.nodeId).toBeNull()
    })
})
