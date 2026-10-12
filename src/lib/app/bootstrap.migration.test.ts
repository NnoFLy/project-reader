import { afterEach, describe, expect, it, vi } from "vitest"
import { MemoryStorageBackend } from "../core/storage"
import { createBuiltinApplication } from "./bootstrap"

// Loading the legacy documents barrel during a memory-only startup instantiates the old VFS
// singleton. Library must receive migration only through the host capability instead.
vi.mock("../modules/documents", () => {
    throw new Error("legacy VFS barrel must not load during memory-only startup")
})

afterEach(() => {
    vi.unstubAllGlobals()
})

describe("production bootstrap migration boundary", () => {
    it("starts without importing or instantiating the legacy VFS", async () => {
        vi.stubGlobal("indexedDB", undefined)
        const application = createBuiltinApplication({ storage: new MemoryStorageBackend() })

        await expect(application.start()).resolves.toBeUndefined()
        expect(application.state).toBe("running")
        await application.stop()
    })
})
