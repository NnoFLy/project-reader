import { describe, expect, it } from "vitest"
import { belongsToExtension, isNamespacedId } from "./contracts"

describe("namespaced extension IDs", () => {
    it("requires a namespace separator", () => {
        expect(isNamespacedId("viewer.next-page")).toBe(true)
        expect(isNamespacedId("next-page")).toBe(false)
        expect(isNamespacedId("viewer.")).toBe(false)
    })

    it("accepts only host-owned builtin short namespaces", () => {
        expect(belongsToExtension("builtin.viewer.next-page", "builtin.viewer")).toBe(true)
        expect(belongsToExtension("viewer.next-page", "builtin.viewer")).toBe(true)
        expect(belongsToExtension("viewer.next-page", "runtime.viewer")).toBe(false)
        expect(belongsToExtension("other.next-page", "builtin.other")).toBe(false)
        expect(belongsToExtension("runtime.viewer.next-page", "runtime.viewer")).toBe(true)
        expect(belongsToExtension("library.open", "builtin.viewer")).toBe(false)
    })
})
