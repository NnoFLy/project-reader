import { describe, expect, it, vi } from "vitest"
import { NotificationServiceImpl } from "./service"

describe("NotificationServiceImpl", () => {
    it("notifies subscribers when a notification is disposed", () => {
        const service = new NotificationServiceImpl()
        const onRemove = vi.fn()
        service.subscribe(vi.fn(), onRemove)

        const notification = service.error("Unable to open document")
        expect(service.list()).toHaveLength(1)

        notification.dispose()

        expect(service.list()).toEqual([])
        expect(onRemove).toHaveBeenCalledOnce()
        expect(onRemove).toHaveBeenCalledWith({
            id: expect.stringMatching(/^notification-/),
            level: "error",
            message: "Unable to open document",
        })
    })

    it("disposes a notification handle when the host dismisses its id", () => {
        const service = new NotificationServiceImpl()
        const onRemove = vi.fn()
        service.subscribe(vi.fn(), onRemove)

        const notification = service.info("Expires")

        expect(service.dismiss(service.list()[0].id)).toBe(true)
        expect(service.dismiss("missing")).toBe(false)
        expect(service.list()).toEqual([])
        expect(onRemove).toHaveBeenCalledOnce()
        notification.dispose()
        expect(onRemove).toHaveBeenCalledOnce()
    })

    it("does not notify removal more than once", () => {
        const service = new NotificationServiceImpl()
        const onRemove = vi.fn()
        service.subscribe(vi.fn(), onRemove)

        const notification = service.info("Done")
        notification.dispose()
        notification.dispose()

        expect(onRemove).toHaveBeenCalledOnce()
    })
})
