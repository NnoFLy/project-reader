import { afterEach, describe, expect, it, vi } from "vitest"
import { createPromptCommands, type PromptCommandActions } from "./promptCommands"
import * as runtime from "$lib/paraglide/runtime"

afterEach(() => vi.restoreAllMocks())

describe("Prompt command labels", () => {
    it("localizes every label while keeping its English alias", () => {
        const actions: PromptCommandActions = {
            close: vi.fn(),
            next: vi.fn(),
            previous: vi.fn(),
            select: vi.fn(),
            navigateBack: vi.fn(),
            canNavigateBack: () => true,
            historyBack: vi.fn(),
            historyForward: vi.fn(),
        }
        const commands = Object.values(createPromptCommands(actions))
        const locale = vi.spyOn(runtime, "getLocale").mockReturnValue("en")
        const englishLabels = commands.map((command) => command.label())

        locale.mockReturnValue("ru")
        commands.forEach((command, index) => {
            expect(command.label().trim(), command.id).toBeTruthy()
            expect(command.label(), command.id).not.toBe(englishLabels[index])
            expect(command.englishLabel(), command.id).toBe(englishLabels[index])
        })
    })
})
