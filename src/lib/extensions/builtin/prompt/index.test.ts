import { describe, expect, it } from "vitest"
import { CommandRegistryImpl } from "$lib/core/commands"
import {
    InvalidCommandPayloadError,
    type ExtensionContext,
    type Lifecycle,
    type ViewRegistry,
} from "$lib/extension-api"
import { activatePrompt, openCommandPalette, promptStore } from "./index"

function createPromptContext() {
    const commands = new CommandRegistryImpl("builtin.prompt")
    const disposeListeners: Array<() => void | Promise<void>> = []
    const lifecycle: Lifecycle = {
        state: "enabled",
        onDispose(listener) {
            disposeListeners.push(listener)
            return { dispose: () => undefined }
        },
        isDisposed: () => false,
    }
    const views: ViewRegistry = {
        register: () => ({ dispose: () => undefined }),
        registerNative: () => ({ dispose: () => undefined }),
        get: () => undefined,
        list: () => [],
    }
    const context = {
        extension: { id: "builtin.prompt", name: "Prompt", version: "0.0.1", engine: ">=0.0.1" },
        commands,
        views,
        settings: {} as ExtensionContext["settings"],
        documents: {} as ExtensionContext["documents"],
        storage: {} as ExtensionContext["storage"],
        notifications: {} as ExtensionContext["notifications"],
        lifecycle,
    } satisfies ExtensionContext
    return {
        context,
        async dispose() {
            await Promise.all(disposeListeners.map((listener) => listener()))
            commands.dispose()
        },
    }
}

describe("builtin.prompt activation", () => {
    it("registers prompt commands through the extension command contract", async () => {
        const { context, dispose } = createPromptContext()
        activatePrompt(context)

        expect(context.commands.list().map(({ id }) => id)).toEqual(["prompt.open", "prompt.close"])
        await expect(
            context.commands.execute("prompt.open", { initialQuery: 1 }),
        ).rejects.toBeInstanceOf(InvalidCommandPayloadError)

        const palette = openCommandPalette()
        await new Promise((resolve) => setTimeout(resolve, 0))
        expect(promptStore.snapshot?.items.map(({ id }) => id)).toEqual([
            "prompt.open",
            "prompt.close",
        ])
        promptStore.close()
        await palette

        const pending = promptStore.open({ id: "active-prompt", items: () => [] })
        await new Promise((resolve) => setTimeout(resolve, 0))
        expect(promptStore.snapshot).not.toBeNull()
        await dispose()
        await pending
        expect(promptStore.snapshot).toBeNull()
        expect(promptStore.query).toBe("")
        expect(context.commands.list()).toEqual([])
    })
})
