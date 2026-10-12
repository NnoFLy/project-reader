import { describe, expect, it } from "vitest"
import { InvalidCommandPayloadError } from "$lib/extension-api"
import { getPromptCommandRegistry } from "$lib/modules/prompt"
import { createBuiltinHost } from "../index"

describe("builtin.prompt activation", () => {
    it("registers prompt commands through the extension registry", async () => {
        const host = createBuiltinHost()
        await host.start()

        const commands = host.contributions
            .listCommands()
            .filter(({ id }) => id.startsWith("prompt."))
        expect(commands.map(({ id }) => id)).toEqual(["prompt.open", "prompt.close"])
        expect(getPromptCommandRegistry()).toBeDefined()

        await expect(
            host.contributions.listCommands()[0]?.validatePayload?.({ initialQuery: 1 }),
        ).toBe(false)
        await expect(
            getPromptCommandRegistry()?.execute("prompt.open", { initialQuery: 1 }),
        ).rejects.toBeInstanceOf(InvalidCommandPayloadError)

        await host.dispose()
        expect(getPromptCommandRegistry()).toBeUndefined()
    })
})
