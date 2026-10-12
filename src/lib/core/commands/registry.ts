import {
    assertNamespacedId,
    belongsToExtension,
    canonicalBuiltinId,
    InvalidCommandPayloadError,
    UnknownCommandError,
    type CommandContribution,
    type CommandRegistry,
    type Disposable,
    type KeybindingContribution,
    type RegisteredCommand,
} from "../../extension-api"

export class CommandRegistryImpl implements CommandRegistry {
    private readonly commands = new Map<string, RegisteredCommand>()
    private readonly keybindings = new Map<string, KeybindingContribution[]>()
    private disposed = false

    constructor(
        private readonly extensionId: string,
        private readonly assertCommandAvailable?: (commandId: string) => void,
    ) {}

    register(command: CommandContribution): Disposable {
        this.assertUsable()
        assertNamespacedId(command.id, "command")
        if (!belongsToExtension(command.id, this.extensionId)) {
            throw new Error(
                `Command ${command.id} is outside extension namespace ${this.extensionId}`,
            )
        }
        if (this.commands.has(command.id))
            throw new Error(`Command is already registered: ${command.id}`)
        if (
            [...this.commands.keys()].some((registeredId) =>
                commandIdsShadow(command.id, registeredId),
            )
        ) {
            throw new Error(`Command shadows an existing command: ${command.id}`)
        }
        this.assertCommandAvailable?.(command.id)
        const registered = { ...command, extensionId: this.extensionId }
        this.commands.set(command.id, registered)
        let active = true
        return {
            dispose: () => {
                if (!active) return
                active = false
                this.commands.delete(command.id)
                this.keybindings.delete(command.id)
            },
        }
    }

    registerKeybinding(binding: KeybindingContribution): Disposable {
        this.assertUsable()
        assertNamespacedId(binding.commandId, "command")
        if (!belongsToExtension(binding.commandId, this.extensionId)) {
            throw new Error(
                `Command ${binding.commandId} is outside extension namespace ${this.extensionId}`,
            )
        }
        const entries = this.keybindings.get(binding.commandId) ?? []
        entries.push(binding)
        this.keybindings.set(binding.commandId, entries)
        let active = true
        return {
            dispose: () => {
                if (!active) return
                active = false
                const current = this.keybindings.get(binding.commandId)
                if (!current) return
                const index = current.indexOf(binding)
                if (index >= 0) current.splice(index, 1)
                if (current.length === 0) this.keybindings.delete(binding.commandId)
            },
        }
    }

    get(commandId: string): RegisteredCommand | undefined {
        return this.commands.get(commandId)
    }

    list(): readonly RegisteredCommand[] {
        return [...this.commands.values()]
    }

    async execute(commandId: string, payload?: unknown, context?: unknown): Promise<unknown> {
        const command = this.commands.get(commandId)
        if (!command) throw new UnknownCommandError(commandId)
        if (command.validatePayload && !command.validatePayload(payload)) {
            throw new InvalidCommandPayloadError(commandId)
        }
        if (command.isEnabled && !(await command.isEnabled(context))) return undefined
        return command.execute(payload)
    }

    dispose(): void {
        this.disposed = true
        this.commands.clear()
        this.keybindings.clear()
    }

    private assertUsable(): void {
        if (this.disposed) throw new Error(`Command registry for ${this.extensionId} is disposed`)
    }
}

function commandIdsShadow(left: string, right: string): boolean {
    const canonicalLeft = canonicalBuiltinId(left)
    const canonicalRight = canonicalBuiltinId(right)
    return (
        canonicalLeft === canonicalRight ||
        canonicalLeft.startsWith(`${canonicalRight}.`) ||
        canonicalRight.startsWith(`${canonicalLeft}.`)
    )
}
