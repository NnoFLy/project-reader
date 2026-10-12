import { describe, expect, it } from "vitest"
import {
    PermissionDeniedError,
    SUPPORTED_EXTENSION_PERMISSIONS,
    createPermissionSet,
    guardExtensionCapability,
} from "./permissions"

describe("extension permissions", () => {
    it("validates and deduplicates manifest permissions", () => {
        const permissions = createPermissionSet(["storage", "storage", "views"])

        expect(permissions.list()).toEqual(["storage", "views"])
        expect(permissions.has("storage")).toBe(true)
        expect(permissions.has("commands")).toBe(false)
        expect(() => permissions.require("commands")).toThrow(PermissionDeniedError)
        expect(() => createPermissionSet(["unknown"] as never)).toThrow(
            "Unsupported permission: unknown",
        )
        expect(SUPPORTED_EXTENSION_PERMISSIONS).toContain("notifications")
    })

    it("gates capability property access", () => {
        const denied = createPermissionSet([])
        const capability = guardExtensionCapability({ value: 1 }, denied, "storage")

        expect(() => capability.value).toThrow("permission: storage")
    })
})
