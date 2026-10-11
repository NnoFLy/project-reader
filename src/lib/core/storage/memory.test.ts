import { describe, expect, it } from "vitest"
import { createExtensionStorage, MemoryStorageBackend } from "./memory"

describe("extension storage", () => {
    it("isolates extension and child namespaces", async () => {
        const backend = new MemoryStorageBackend()
        const viewer = createExtensionStorage(backend, "builtin.viewer")
        const library = createExtensionStorage(backend, "builtin.library")
        await viewer.set("progress", 42)
        await viewer.namespace("book").set("bookmark", 3)
        expect(await library.get("progress")).toBeUndefined()
        expect(await viewer.get("progress")).toBe(42)
        expect(await viewer.namespace("book").get("bookmark")).toBe(3)
        expect(await viewer.keys()).toEqual(["progress"])
    })

    it("runs migrations once and serializes them", async () => {
        const storage = createExtensionStorage(new MemoryStorageBackend(), "builtin.viewer")
        await storage.migrate(1, async (namespace) => namespace.set("ready", true))
        await storage.migrate(1, () => {
            throw new Error("must not run")
        })
        expect(storage.version).toBe(1)
        expect(await storage.get("ready")).toBe(true)
    })
})
