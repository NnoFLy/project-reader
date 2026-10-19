import { afterEach, describe, expect, it, vi } from "vitest"
import { openCommandPalette } from "./commandPalette"
import {
    CommandScope,
    CommandRegistryImpl,
    commandsStore,
    defineCommands,
} from "$lib/modules/commands"
import { setPromptCommandRegistry } from "$lib/extensions/builtin/prompt"
import { promptStore } from "../stores/promptStore.svelte"
import type { CommandRegistry } from "$lib/extension-api"

afterEach(() => promptStore.close())

describe("combined command discovery", () => {
    let scope: CommandScope | undefined
    let registry: CommandRegistryImpl | undefined
    let replacement: CommandScope | undefined

    afterEach(() => {
        promptStore.close()
        replacement?.destroy()
        scope?.destroy()
        registry?.dispose()
        setPromptCommandRegistry(undefined)
        scope = undefined
        registry = undefined
        replacement = undefined
    })

    function createCommands() {
        const hostNext = vi.fn()
        const hostOnly = vi.fn()
        const scopedNext = vi.fn()
        registry = new CommandRegistryImpl("builtin.viewer")
        registry.register({
            id: "viewer.page.next",
            label: "Host next page",
            execute: hostNext,
        })
        registry.register({
            id: "viewer.registry-only",
            label: "Host-only action",
            execute: hostOnly,
        })
        scope = new CommandScope()
        scope.registerAll([
            {
                id: "viewer.page.next",
                label: () => "Следующая страница",
                englishLabel: () => "Next PDF page",
                category: "navigation",
                keymap: "space",
                run: scopedNext,
            },
            {
                id: "viewer.page.previous",
                label: () => "Previous PDF page",
                category: "navigation",
                run: vi.fn(),
            },
        ])
        commandsStore.activeScope = scope
        setPromptCommandRegistry(registry)
        return { scope, registry, hostNext, hostOnly, scopedNext }
    }

    it.each(["default", "scope", "registry"] as const)(
        "merges all available actions via the %s entry point, with scoped overrides winning",
        async (entryPoint) => {
            const { scope, registry, hostNext, scopedNext } = createCommands()
            const source = { default: undefined, scope, registry }[entryPoint]
            const closed = openCommandPalette(source, "")
            await vi.waitFor(() => expect(promptStore.snapshot?.isLoading).toBe(false))

            expect(promptStore.snapshot?.items.map(({ id }) => id)).toEqual([
                "viewer.page.next",
                "viewer.page.previous",
                "viewer.registry-only",
            ])
            expect(promptStore.snapshot?.items[0]).toMatchObject({
                label: "Следующая страница",
                englishLabel: "Next PDF page",
                category: "navigation",
                keymap: "Space",
            })
            await promptStore.selectCurrent()
            await closed
            expect(scopedNext).toHaveBeenCalledOnce()
            expect(hostNext).not.toHaveBeenCalled()
        },
    )

    it("executes registry-only actions through the registry", async () => {
        const { hostOnly } = createCommands()
        const closed = openCommandPalette(undefined, "Host-only action")
        await vi.waitFor(() => expect(promptStore.snapshot?.isLoading).toBe(false))
        expect(promptStore.snapshot?.items[0]?.id).toBe("viewer.registry-only")
        await promptStore.selectCurrent()
        await closed
        expect(hostOnly).toHaveBeenCalledOnce()
    })

    it("keeps the captured handler when Prompt changes the active scope", async () => {
        const { scopedNext, hostNext } = createCommands()
        const closed = openCommandPalette(undefined, "")
        await vi.waitFor(() => expect(promptStore.snapshot?.isLoading).toBe(false))
        const replacementNext = vi.fn()
        replacement = new CommandScope()
        replacement.register({
            id: "viewer.page.next",
            label: () => "Other context",
            category: "navigation",
            run: replacementNext,
        })
        commandsStore.activeScope = replacement

        await promptStore.selectCurrent()
        await closed
        expect(scopedNext).toHaveBeenCalledOnce()
        expect(hostNext).not.toHaveBeenCalled()
        expect(replacementNext).not.toHaveBeenCalled()
    })

    it("closes a merged palette when its reader scope is destroyed", async () => {
        const { scope } = createCommands()
        const closed = openCommandPalette(undefined, "")
        await vi.waitFor(() => expect(promptStore.snapshot?.isLoading).toBe(false))
        scope.destroy()
        await closed
        expect(promptStore.isOpen).toBe(false)
    })

    it("does not resurrect intentionally hidden actions from the registry", async () => {
        const { scope, registry } = createCommands()
        registry.register({ id: "viewer.internal", label: "Internal action", execute: vi.fn() })
        scope.register({
            id: "viewer.internal",
            label: () => "Internal action",
            category: "navigation",
            palette: false,
            run: vi.fn(),
        })
        const closed = openCommandPalette(undefined, "")
        await vi.waitFor(() => expect(promptStore.snapshot?.isLoading).toBe(false))
        expect(promptStore.snapshot?.items.some(({ id }) => id === "viewer.internal")).toBe(false)
        promptStore.close()
        await closed
    })
})

describe("command palette adapter", () => {
    it("captures a scope, lists enabled commands, and executes through its handle", async () => {
        const run = vi.fn()
        const scope = new CommandScope()
        scope.register(
            defineCommands({
                "viewer.page.next": {
                    id: "viewer.page.next",
                    label: () => "Следующая страница",
                    englishLabel: () => "Next page",
                    category: "navigation",
                    keymap: "n",
                    run,
                },
            })["viewer.page.next"],
        )

        const closed = openCommandPalette(scope)
        await new Promise((resolve) => setTimeout(resolve, 0))
        expect(promptStore.snapshot?.items.map(({ id }) => id)).toEqual(["viewer.page.next"])
        expect(promptStore.snapshot?.items[0]).toMatchObject({
            label: "Следующая страница",
            englishLabel: "Next page",
        })
        await promptStore.selectCurrent()
        await closed
        expect(run).toHaveBeenCalledOnce()
    })

    it("discovers command metadata from the core registry and executes by ID", async () => {
        const execute = vi.fn()
        const registry: CommandRegistry = {
            register: vi.fn(),
            registerKeybinding: vi.fn(),
            get: vi.fn(),
            list: () => [
                {
                    id: "library.open",
                    extensionId: "builtin.library",
                    label: "Open library",
                    keybinding: ["ctrl+o"],
                    execute,
                },
            ],
            execute: async (id) => {
                await execute(id)
            },
        }

        const closed = openCommandPalette(registry)
        await new Promise((resolve) => setTimeout(resolve, 0))
        expect(promptStore.snapshot?.items).toMatchObject([
            { id: "library.open", label: "Open library", keymap: "Ctrl+O" },
        ])
        await promptStore.selectCurrent()
        await closed
        expect(execute).toHaveBeenCalledWith("library.open")
    })

    it("dispatches a numeric query to the scoped page command", async () => {
        const run = vi.fn()
        const scope = new CommandScope()
        scope.register(
            defineCommands({
                "viewer.page.go-to": {
                    id: "viewer.page.go-to",
                    label: () => "Go to page",
                    category: "navigation",
                    run,
                },
            })["viewer.page.go-to"],
        )

        const closed = openCommandPalette(scope, "12")
        await new Promise((resolve) => setTimeout(resolve, 0))
        const parsedOption = promptStore.snapshot?.request.parseQuery?.("12") as
            | { label: string; englishLabel?: string; description?: string }
            | undefined
        expect(parsedOption).toMatchObject({
            label: "Перейти к странице 12",
            englishLabel: "Go to page 12",
        })
        expect(promptStore.snapshot?.items[0]).toMatchObject({
            id: "viewer.page.go-to:12",
            label: "Перейти к странице 12",
            englishLabel: "Go to page 12",
            category: "navigation",
        })
        expect(parsedOption?.description).toBeUndefined()
        await promptStore.selectCurrent()
        await closed
        expect(run).toHaveBeenCalledWith({ page: 12, isJump: true })
    })

    it("restores the previous prompt query and honors an explicit empty query", async () => {
        const scope = new CommandScope()
        scope.register(
            defineCommands({
                "viewer.close": {
                    id: "viewer.close",
                    label: () => "Close viewer",
                    category: "commands",
                    run: () => {},
                },
            })["viewer.close"],
        )

        void promptStore.open({
            id: "viewer-search",
            initialQuery: "search phrase",
            items: () => [],
        })
        promptStore.close()

        void openCommandPalette(scope)
        await new Promise((resolve) => setTimeout(resolve, 0))
        expect(promptStore.getQuery()).toBe("search phrase")
        promptStore.close()

        void openCommandPalette(scope, "")
        await new Promise((resolve) => setTimeout(resolve, 0))
        expect(promptStore.getQuery()).toBe("")
    })

    it("closes when its captured scope is destroyed", async () => {
        const scope = new CommandScope()
        scope.register(
            defineCommands({
                "viewer.close": {
                    id: "viewer.close",
                    label: () => "Close viewer",
                    category: "commands",
                    run: () => {},
                },
            })["viewer.close"],
        )

        const closed = openCommandPalette(scope)
        await new Promise((resolve) => setTimeout(resolve, 0))
        expect(promptStore.isOpen).toBe(true)
        scope.destroy()
        await closed
        expect(promptStore.isOpen).toBe(false)
    })

    it("omits disabled commands", async () => {
        const scope = new CommandScope()
        scope.register(
            defineCommands({
                "viewer.page.next": {
                    id: "viewer.page.next",
                    label: () => "Next page",
                    category: "navigation",
                    disabled: () => true,
                    run: () => {},
                },
            })["viewer.page.next"],
        )

        void openCommandPalette(scope)
        await new Promise((resolve) => setTimeout(resolve, 0))
        expect(promptStore.snapshot?.items).toEqual([])
    })
})
