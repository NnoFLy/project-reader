import { describe, expect, it } from "vitest"
import { getViewerStorageErrorDiagnostic } from "./viewerDiagnostics"

describe("viewer storage diagnostics", () => {
    it("preserves a safe error code without the original message or stack", () => {
        const error = new Error("document text and source URL")

        expect(getViewerStorageErrorDiagnostic(error, "Unable to save viewer data")).toEqual({
            code: "ViewerStorageError",
            message: "Unable to save viewer data",
        })
        expect(
            JSON.stringify(getViewerStorageErrorDiagnostic(error, "Unable to save viewer data")),
        ).not.toContain(error.message)
    })

    it("uses a stable fallback for non-error thrown values", () => {
        expect(getViewerStorageErrorDiagnostic("secret", "Unable to load viewer data")).toEqual({
            code: "ViewerStorageError",
            message: "Unable to load viewer data",
        })
    })
})
