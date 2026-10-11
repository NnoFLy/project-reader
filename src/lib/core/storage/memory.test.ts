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

    it("persists migration versions across storage instances", async () => {
        const backend = new MemoryStorageBackend()
        const first = createExtensionStorage(backend, "builtin.viewer")
        await first.migrate(1, async (namespace) => namespace.set("ready", true))

        const reloaded = createExtensionStorage(backend, "builtin.viewer")
        await reloaded.migrate(1, () => {
            throw new Error("must not run after reload")
        })
        expect(reloaded.version).toBe(1)
        expect(await reloaded.get("ready")).toBe(true)
    })

    it("allows a failed migration to be retried", async () => {
        const storage = createExtensionStorage(new MemoryStorageBackend(), "builtin.viewer")
        await expect(
            storage.migrate(1, () => Promise.reject(new Error("temporary failure"))),
        ).rejects.toThrow("Migration 1 failed")
        await storage.migrate(1, async (namespace) => namespace.set("ready", true))
        expect(storage.version).toBe(1)
        expect(await storage.get("ready")).toBe(true)
    })
})
