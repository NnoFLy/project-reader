import { afterEach, describe, expect, it, vi } from "vitest"
import { configureLibraryHostBridge, executeLibraryHostCommand } from "./libraryHostBridge"
import { promptStore } from "../commands/promptStore.svelte"

const prompt = promptStore

afterEach(() => configureLibraryHostBridge(undefined))

describe("library host bridge", () => {
    it("executes commands through the injected host service", async () => {
        const execute = vi.fn().mockResolvedValue({ status: "executed" })
        configureLibraryHostBridge({ prompt, execute })

        await expect(
            executeLibraryHostCommand("viewer.open", { bookId: "book-1" }),
        ).resolves.toEqual({ status: "executed" })
        expect(execute).toHaveBeenCalledWith("viewer.open", { bookId: "book-1" })
    })
})
