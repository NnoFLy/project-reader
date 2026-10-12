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

    it("allows a failed migration to be retried without retaining partial writes", async () => {
        const storage = createExtensionStorage(new MemoryStorageBackend(), "builtin.viewer")
        await expect(
            storage.migrate(1, async (namespace) => {
                await namespace.set("partial", true)
                throw new Error("temporary failure")
            }),
        ).rejects.toThrow("Migration 1 failed")
        expect(await storage.get("partial")).toBeUndefined()
        await storage.migrate(1, async (namespace) => namespace.set("ready", true))
        expect(storage.version).toBe(1)
        expect(await storage.get("ready")).toBe(true)
    })

    it("repairs an interrupted migration before loading the namespace", async () => {
        const backend = new MemoryStorageBackend()
        const prefix = "extension:builtin.viewer"
        await backend.set(`${prefix}:old`, "before")
        await backend.set(`${prefix}:partial`, "after")
        await backend.set(`${prefix}:__storage_meta:migration-journal`, {
            version: 2,
            previousVersion: 1,
            values: [{ key: `${prefix}:old`, value: "before" }],
        })
        await backend.set(`${prefix}:__storage_meta:migration-version`, 1)

        const storage = createExtensionStorage(backend, "builtin.viewer")
        await storage.migrate(2, async (namespace) => namespace.set("ready", true))

        expect(storage.version).toBe(2)
        expect(await storage.get("old")).toBe("before")
        expect(await storage.get("partial")).toBeUndefined()
        expect(await storage.get("ready")).toBe(true)
        expect(await backend.get(`${prefix}:__storage_meta:migration-journal`)).toBeUndefined()
    })
})
