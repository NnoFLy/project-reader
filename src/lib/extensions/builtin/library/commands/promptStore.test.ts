import { afterEach, describe, expect, it } from "vitest"
import type { StorageNamespace } from "$lib/extension-api"
import { configurePromptStorage, promptStore } from "./promptStore.svelte"

function memoryStorage() {
    const values = new Map<string, unknown>()
    const storage: StorageNamespace = {
        get: async <T>(key: string) => values.get(key) as T | undefined,
        set: async <T>(key: string, value: T) => {
            values.set(key, value)
        },
        delete: async (key) => {
            values.delete(key)
        },
        has: async (key) => values.has(key),
        keys: async () => [...values.keys()],
        clear: async () => {
            values.clear()
        },
    }
    return { storage, values }
}

afterEach(() => configurePromptStorage(undefined))

describe("library prompt history storage", () => {
    it("persists history in the library prompt namespace", async () => {
        const { storage, values } = memoryStorage()
        configurePromptStorage(storage)

        promptStore.setLastQuery("reader")
        await Promise.resolve()

        expect(values.get("prompt.query-history")).toEqual({
            lastQuery: "reader",
            retainedQueries: {},
        })
    })
})
