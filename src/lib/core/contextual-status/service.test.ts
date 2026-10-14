import { describe, expect, it, vi } from "vitest"
import { ContextualStatusServiceImpl } from "./service"

const status = (line1: string, priority: number) => ({ line1, line2: line1, priority })

describe("ContextualStatusServiceImpl", () => {
    it("resolves publications by priority and replaces each source", () => {
        const service = new ContextualStatusServiceImpl()
        service.forExtension("builtin.library").publish(status("selection", 3))
        service.forExtension("builtin.viewer").publish(status("search", 2))
        expect(service.current?.line1).toBe("selection")

        service.forExtension("builtin.library").publish(status("import", 1))
        expect(service.current?.line1).toBe("search")

        service.forExtension("builtin.viewer").clear()
        expect(service.current?.line1).toBe("import")
    })

    it("does not let an old publication clear a source replacement", () => {
        const service = new ContextualStatusServiceImpl()
        const oldPublication = service.forExtension("builtin.library").publish(status("old", 1))
        service.forExtension("builtin.library").publish(status("new", 1))

        oldPublication.dispose()
        expect(service.current?.line1).toBe("new")

        service.forExtension("builtin.library").clear()
        expect(service.current).toBeNull()
    })

    it("binds publication and clearing to the requested extension", () => {
        const service = new ContextualStatusServiceImpl()
        const library = service.forExtension("builtin.library")
        const viewer = service.forExtension("builtin.viewer")

        library.publish(status("library", 1))
        viewer.publish(status("viewer", 2))
        library.clear()

        expect(service.current?.line1).toBe("viewer")
        expect(() => service.forExtension("not-namespaced")).toThrow("extension")
    })

    it("notifies subscribers immediately and on lifecycle reset", () => {
        const service = new ContextualStatusServiceImpl()
        const listener = vi.fn()
        const subscription = service.subscribe(listener)
        expect(listener).toHaveBeenLastCalledWith(null)

        service.forExtension("builtin.library").publish(status("active", 1))
        service.reset()
        expect(listener).toHaveBeenLastCalledWith(null)
        expect(listener).toHaveBeenCalledTimes(3)

        subscription.dispose()
        service.forExtension("builtin.library").publish(status("ignored", 1))
        expect(listener).toHaveBeenCalledTimes(3)
    })
})
