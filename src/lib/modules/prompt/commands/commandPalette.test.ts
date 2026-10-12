import { afterEach, describe, expect, it, vi } from "vitest"
import { openCommandPalette } from "./commandPalette"
import { CommandScope, defineCommands } from "$lib/modules/commands"
import { promptStore } from "../stores/promptStore.svelte"
import type { CommandRegistry } from "$lib/extension-api"

afterEach(() => promptStore.close())

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
