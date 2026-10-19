import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { MemoryStorageBackend } from "$lib/core/storage"
import { createBuiltinHost } from "$lib/extensions/builtin"
import { settingsStore } from "$lib/extensions/builtin/settings"
import { openCommandPalette, promptStore } from "$lib/extensions/builtin/prompt"
import * as localeRuntime from "$lib/paraglide/runtime"

vi.mock("$app/state", () => ({
    page: { url: new URL("https://example.test/") },
}))

let host: ReturnType<typeof createBuiltinHost> | undefined

afterEach(async () => {
    await host?.dispose()
    host = undefined
    vi.restoreAllMocks()
})

describe("settings value choosers", () => {
    beforeEach(async () => {
        host = createBuiltinHost({ storage: new MemoryStorageBackend() })
        await host.start()
    })

    it.each([
        {
            command: "settings.theme",
            request: "settings-theme",
            values: ["light", "dark", "system"],
        },
        { command: "settings.language", request: "settings-language", values: ["ru", "en"] },
    ])(
        "opens $command with its values and a command-palette parent",
        async ({ command, request, values }) => {
            const original = settingsStore.getSettings()
            const commands = host!.contributions.forExtension("builtin.settings").commands
            const pending = commands.execute(command)
            await vi.waitFor(() => expect(promptStore.snapshot?.isLoading).toBe(false))

            expect(promptStore.snapshot?.request.id).toBe(request)
            expect(promptStore.snapshot?.items.map(({ value }) => value)).toEqual(values)
            expect(promptStore.snapshot?.items[promptStore.snapshot.selectedIndex]?.value).toBe(
                command === "settings.theme" ? original.theme : original.language,
            )
            expect(settingsStore.getSettings()).toEqual(original)
            expect(promptStore.canNavigateBack).toBe(true)

            promptStore.navigateBack()
            await pending
            await vi.waitFor(() => expect(promptStore.snapshot?.isLoading).toBe(false))
            expect(promptStore.snapshot?.request.id).toBe("command-palette")
            expect(promptStore.snapshot?.items.length).toBeGreaterThan(0)
            expect(settingsStore.getSettings()).toEqual(original)
        },
    )

    it.each([
        { command: "settings.theme", query: "Change theme" },
        { command: "settings.language", query: "Change language" },
    ])(
        "restores the parent search and selection after leaving $command",
        async ({ command, query }) => {
            const original = settingsStore.getSettings()
            const palette = openCommandPalette(undefined, query)
            await vi.waitFor(() => expect(promptStore.snapshot?.isLoading).toBe(false))
            expect(promptStore.snapshot?.items[0]?.id).toBe(command)
            const parent = promptStore.snapshot
            const selection = promptStore.selectCurrent()
            await vi.waitFor(() =>
                expect(promptStore.snapshot?.request.id).not.toBe("command-palette"),
            )

            promptStore.setQuery("x")
            expect(promptStore.canNavigateBack).toBe(false)
            promptStore.navigateBack()
            expect(promptStore.snapshot?.request.id).not.toBe("command-palette")
            promptStore.setQuery("")
            promptStore.navigateBack()
            await selection

            expect(promptStore.snapshot).toBe(parent)
            expect(promptStore.query).toBe(query)
            expect(settingsStore.getSettings()).toEqual(original)
            promptStore.close()
            await palette
        },
    )

    it.each(["light", "dark", "system"] as const)(
        "applies the chosen %s theme and closes the flow",
        async (theme) => {
            const commands = host!.contributions.forExtension("builtin.settings").commands
            const pending = commands.execute("settings.theme")
            await vi.waitFor(() => expect(promptStore.snapshot?.isLoading).toBe(false))
            const index = promptStore.snapshot!.items.findIndex(({ value }) => value === theme)
            promptStore.moveSelection(index - promptStore.snapshot!.selectedIndex)
            await promptStore.selectCurrent()
            await pending

            expect(settingsStore.theme).toBe(theme)
            expect(promptStore.isOpen).toBe(false)
            expect(promptStore.hasParent).toBe(false)
        },
    )

    it.each(["en", "ru"] as const)(
        "applies the chosen %s language and closes the flow",
        async (language) => {
            const setLocale = vi.spyOn(localeRuntime, "setLocale")
            const commands = host!.contributions.forExtension("builtin.settings").commands
            const pending = commands.execute("settings.language")
            await vi.waitFor(() => expect(promptStore.snapshot?.isLoading).toBe(false))
            const index = promptStore.snapshot!.items.findIndex(({ value }) => value === language)
            promptStore.moveSelection(index - promptStore.snapshot!.selectedIndex)
            await promptStore.selectCurrent()
            await pending

            expect(settingsStore.language).toBe(language)
            expect(setLocale).toHaveBeenCalledWith(language, { reload: false })
            expect(promptStore.isOpen).toBe(false)
            expect(promptStore.hasParent).toBe(false)
        },
    )

    it("does not close a replacement Prompt when a selection finishes", async () => {
        const commands = host!.contributions.forExtension("builtin.settings").commands
        const pending = commands.execute("settings.theme")
        await vi.waitFor(() => expect(promptStore.snapshot?.isLoading).toBe(false))
        const selection = promptStore.selectCurrent()
        const replacement = promptStore.open({ id: "replacement", items: () => [] })
        await selection
        await pending

        expect(promptStore.snapshot?.request.id).toBe("replacement")
        promptStore.close()
        await replacement
    })

    it.each(["settings.theme", "settings.language"])(
        "cancels a pending %s chooser when Settings is disabled",
        async (command) => {
            const original = settingsStore.getSettings()
            const commands = host!.contributions.forExtension("builtin.settings").commands
            const pending = commands.execute(command)
            await vi.waitFor(() => expect(promptStore.snapshot?.isLoading).toBe(false))
            await host!.disable("builtin.settings")
            await pending
            await promptStore.selectCurrent()

            expect(settingsStore.getSettings()).toEqual(original)
            expect(promptStore.isOpen).toBe(false)
            expect(promptStore.hasParent).toBe(false)
        },
    )

    it("does not cancel an unrelated Prompt when Settings is disabled", async () => {
        const commands = host!.contributions.forExtension("builtin.settings").commands
        const pending = commands.execute("settings.theme")
        await vi.waitFor(() => expect(promptStore.snapshot?.isLoading).toBe(false))
        const replacement = promptStore.open({ id: "unrelated", items: () => [] })
        await host!.disable("builtin.settings")
        await pending

        expect(promptStore.snapshot?.request.id).toBe("unrelated")
        promptStore.close()
        await replacement
    })

    it("cancels the entire flow without changing the setting", async () => {
        const original = settingsStore.theme
        const commands = host!.contributions.forExtension("builtin.settings").commands
        const pending = commands.execute("settings.theme")
        await vi.waitFor(() => expect(promptStore.snapshot?.isLoading).toBe(false))
        promptStore.close()
        await pending

        expect(settingsStore.theme).toBe(original)
        expect(promptStore.hasParent).toBe(false)
    })
})
