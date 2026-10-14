import type { CommandContribution, Disposable } from "./contracts"

export interface CommandKeybinding {
    readonly commandId: string
    readonly keybinding: string
    readonly extensionId: string
}

export interface RegisteredCommand extends CommandContribution {
    readonly extensionId: string
}

export interface CommandRegistry {
    register(command: CommandContribution): Disposable
    registerKeybinding(binding: import("./contracts").KeybindingContribution): Disposable
    get(commandId: string): RegisteredCommand | undefined
    list(): readonly RegisteredCommand[]
    execute(commandId: string, payload?: unknown, context?: unknown): Promise<unknown>
    readonly listKeybindings?: () => readonly CommandKeybinding[]
}

export class UnknownCommandError extends Error {
    readonly code = "command.not-found"

    constructor(readonly commandId: string) {
        super(`Command is not registered: ${commandId}`)
        this.name = "UnknownCommandError"
    }
}

export class InvalidCommandPayloadError extends Error {
    readonly code = "command.invalid-payload"

    constructor(readonly commandId: string) {
        super(`Invalid payload for command: ${commandId}`)
        this.name = "InvalidCommandPayloadError"
    }
}
