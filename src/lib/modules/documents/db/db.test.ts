import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const { closeSpy, openSpy } = vi.hoisted(() => ({
    closeSpy: vi.fn(),
    openSpy: vi.fn(() => Promise.resolve()),
}))

vi.mock("dexie", () => {
    class MockDexie {
        books = { get: vi.fn(async () => undefined) }
        previews = { get: vi.fn(async () => undefined) }
        folders = { get: vi.fn(async () => undefined) }
        fileContents = { get: vi.fn(async () => undefined) }
        indexedTexts = { get: vi.fn(async () => undefined) }
        userNotes = { get: vi.fn(async () => undefined) }
        bookmarks = { get: vi.fn(async () => undefined) }

        version(_version: number) {
            return {
                stores: () => ({ upgrade: () => undefined }),
            }
        }

        transaction(_mode: unknown, _tables: unknown, callback: () => Promise<unknown>) {
            return callback()
        }

        open() {
            return openSpy()
        }

        close() {
            closeSpy()
        }
    }

    return { Dexie: MockDexie }
})

import { Database } from "./db"

beforeEach(() => {
    vi.stubGlobal("indexedDB", {})
})

afterEach(() => {
    vi.clearAllMocks()
    vi.unstubAllGlobals()
})

describe("Database ownership", () => {
    it("only closes the shared Dexie database after the final wrapper closes", () => {
        const first = new Database()
        const second = new Database()

        first.close()
        expect(closeSpy).not.toHaveBeenCalled()

        second.close()
        expect(closeSpy).toHaveBeenCalledOnce()

        second.close()
        expect(closeSpy).toHaveBeenCalledOnce()
    })

    it("reopens the shared Dexie database for a new owner after the final close", () => {
        const first = new Database()
        first.close()
        openSpy.mockClear()

        const second = new Database()

        expect(openSpy).toHaveBeenCalledOnce()
        second.close()
    })

    it("allows a later owner to retry after a shared open failure", async () => {
        openSpy.mockRejectedValueOnce(new Error("open failed"))
        const first = new Database()
        await Promise.resolve()
        await Promise.resolve()

        const second = new Database()

        expect(openSpy).toHaveBeenCalledTimes(2)
        first.close()
        second.close()
    })

    it("does not open Dexie during SSR", () => {
        vi.unstubAllGlobals()
        const owner = new Database()

        expect(openSpy).not.toHaveBeenCalled()
        owner.close()
    })

    it("rejects closed-wrapper table and transaction operations without closing shared viewers", async () => {
        const first = new Database()
        const second = new Database()

        first.close()

        await expect(first.files.get("book")).rejects.toThrow("closed")
        await expect(first.transaction("r", ["books"], async () => undefined)).rejects.toThrow(
            "closed",
        )
        await expect(second.files.get("book")).resolves.toBeUndefined()

        second.close()
    })
})
