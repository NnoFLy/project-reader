import { describe, expect, it, vi } from "vitest"
import { ContextualStatusServiceImpl } from "./service"

const status = (line1: string, priority: number) => ({ line1, line2: line1, priority })

describe("ContextualStatusServiceImpl", () => {
    it("resolves publications by priority and replaces each source", () => {
        const service = new ContextualStatusServiceImpl()
        service.publish("builtin.library", status("selection", 3))
        service.publish("builtin.viewer", status("search", 2))
        expect(service.current?.line1).toBe("selection")

        service.publish("builtin.library", status("import", 1))
        expect(service.current?.line1).toBe("search")

        service.clear("builtin.viewer")
        expect(service.current?.line1).toBe("import")
    })

    it("does not let an old publication clear a source replacement", () => {
        const service = new ContextualStatusServiceImpl()
        const oldPublication = service.publish("builtin.library", status("old", 1))
        service.publish("builtin.library", status("new", 1))

        oldPublication.dispose()
        expect(service.current?.line1).toBe("new")

        service.clear("builtin.library")
        expect(service.current).toBeNull()
    })

    it("notifies subscribers immediately and on lifecycle reset", () => {
        const service = new ContextualStatusServiceImpl()
        const listener = vi.fn()
        const subscription = service.subscribe(listener)
        expect(listener).toHaveBeenLastCalledWith(null)

        service.publish("builtin.library", status("active", 1))
        service.reset()
        expect(listener).toHaveBeenLastCalledWith(null)
        expect(listener).toHaveBeenCalledTimes(3)

        subscription.dispose()
        service.publish("builtin.library", status("ignored", 1))
        expect(listener).toHaveBeenCalledTimes(3)
    })
})
