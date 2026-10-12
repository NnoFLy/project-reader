import { tick } from "svelte"
import type { CommandRegistry, RegisteredCommand } from "$lib/extension-api"
import { commandsStore, formatKeyString, type CommandScope } from "$lib/core/commands"
import { getPromptCommandRegistry } from "../commandRegistry"
import { promptStore, type PromptItem } from "../index"
import * as m from "$lib/paraglide/messages"

type CommandSource = CommandScope | CommandRegistry

type PaletteChoice = {
    id: string
    label: string
    englishLabel?: string
    description?: string
    category: "commands" | "settings" | "navigation" | "menu" | "books" | "bookmarks"
    keymap?: string | string[]
    execute: () => Promise<void>
}

function isCoreRegistry(source: CommandSource): source is CommandRegistry {
    return !("listPaletteCommands" in source)
}

function corePaletteCommands(registry: CommandRegistry): PaletteChoice[] {
    return registry.list().map((command: RegisteredCommand) => {
        const label = typeof command.label === "function" ? command.label() : command.label
        const formattedKeymap = command.keybinding?.map((key) => formatKeyString(key))
        const keymap =
            formattedKeymap && formattedKeymap.length === 1 ? formattedKeymap[0] : formattedKeymap
        return {
            id: command.id,
            label,
            keymap,
            category: "commands",
            execute: async () => {
                await registry.execute(command.id)
            },
        }
    })
}

export async function openCommandPalette(
    source: CommandSource = getPromptCommandRegistry() ??
        commandsStore.activeScope ??
        commandsStore.root,
    initialQuery?: string,
): Promise<void> {
    const commands = isCoreRegistry(source) ? undefined : source.listPaletteCommands()
    const commandItems: PromptItem<PaletteChoice>[] = (
        commands
            ? commands.map((command) => {
                  const keymap = Array.isArray(command.keymap)
                      ? command.keymap.map(formatKeyString)
                      : command.keymap
                        ? formatKeyString(command.keymap)
                        : undefined
                  const choice: PaletteChoice = {
                      id: command.id,
                      label: command.label,
                      englishLabel: command.englishLabel,
                      description: command.subtitle,
                      category: command.category,
                      keymap,
                      execute: async () => {
                          await command.execute()
                      },
                  }
                  return {
                      ...choice,
                      presentation: { kind: command.category },
                      value: choice,
                  }
              })
            : corePaletteCommands(source as CommandRegistry).map((choice) => ({
                  ...choice,
                  presentation: { kind: choice.category },
                  value: choice,
              }))
    ) as PromptItem<PaletteChoice>[]

    const scope = isCoreRegistry(source)
        ? (commandsStore.activeScope ?? commandsStore.root)
        : source
    const parsePageChoice = (query: string): PaletteChoice | undefined => {
        const pageNumber = Number(query.trim())
        if (!Number.isInteger(pageNumber) || pageNumber < 1) return undefined
        if (!scope?.canExecute("viewer.page.go-to")) return undefined
        return {
            id: `viewer.page.go-to:${pageNumber}`,
            label: m.go_to_page({ page: pageNumber }),
            englishLabel: m.go_to_page({ page: pageNumber }, { locale: "en" }),
            category: "navigation",
            execute: async () => {
                await scope.execute("viewer.page.go-to", { page: pageNumber, isJump: true })
            },
        }
    }

    const request = {
        id: "command-palette",
        initialQuery,
        rememberQuery: true,
        restoreQuery: true,
        items: (query: string) => {
            const pageChoice = parsePageChoice(query)
            return pageChoice
                ? [
                      {
                          ...pageChoice,
                          presentation: { kind: pageChoice.category },
                          value: pageChoice,
                      },
                      ...commandItems,
                  ]
                : commandItems
        },
        filter: "fuzzy" as const,
        parseQuery: parsePageChoice,
        onSelect: async (command: PaletteChoice) => {
            await tick()
            await command.execute()
        },
    }
    const closeIfCurrent = () => {
        if (promptStore.snapshot?.request === request) promptStore.close()
    }
    const stopWatchingScope = scope?.onDestroy(closeIfCurrent) ?? (() => undefined)
    const stopWatchingCommands =
        commands?.map((command) => command.onUnavailable(closeIfCurrent)) ?? []
    try {
        await promptStore.open(request)
    } finally {
        stopWatchingScope()
        stopWatchingCommands.forEach((stop) => stop())
    }
}
