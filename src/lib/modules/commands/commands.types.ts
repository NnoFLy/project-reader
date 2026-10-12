import type { CommandId, ExecuteArgs } from "./appCommandPayloads"

export type CommandCategory =
    | "commands"
    | "settings"
    | "navigation"
    | "menu"
    | "books"
    | "bookmarks"

export type CommandExecutionResult =
    | { status: "executed"; id: string }
    | { status: "unavailable"; id: string }
    | { status: "disabled"; id: string }

/**
 * UI command metadata. Payloads are deliberately not a global type map: the
 * owning plugin validates and interprets its own payload at its boundary.
 */
export type CommandDefinition<K extends CommandId = CommandId, Payload = unknown> = {
    id: K
    label: () => string
    englishLabel?: () => string
    category: CommandCategory
    keymap?: string | string[]
    subtitle?: () => string
    disabled?: () => boolean
    allowInInputs?: boolean
    dismissFocusedElement?: boolean
    preventDefault?: boolean
    palette?: boolean | (() => boolean)
    shouldHandleKey?: (event: KeyboardEvent) => boolean
    keyboardPayload?: (event: KeyboardEvent) => Payload
    run: (payload: Payload) => void | Promise<void>
}

// The implementation accepts plugin-local payload signatures. The public
// command registry validates unknown values before invoking them.
export type AnyCommandDefinition = CommandDefinition<string, any>
export type CommandDefinitions = Record<string, CommandDefinition<string, any>>

export interface ActiveCommand<K extends CommandId = CommandId> {
    readonly id: K
    readonly label: string
    readonly englishLabel?: string
    readonly category: CommandCategory
    readonly keymap?: string | string[]
    readonly subtitle?: string
    readonly onUnavailable: (callback: () => void) => () => void
    readonly execute: (...args: ExecuteArgs<K>) => Promise<CommandExecutionResult>
}

export function defineCommands<const T extends Partial<CommandDefinitions>>(definitions: T): T {
    for (const [id, definition] of Object.entries(definitions)) {
        if (!definition || definition.id !== id) {
            throw new Error(`Command definition key and id must match: ${id}`)
        }
        if (!definition.label().trim()) {
            throw new Error(`Command ${id} must have a non-empty label`)
        }
    }
    return definitions
}
