import { KeyboardHandler } from "./keyboard"
import {
    assertNamespacedId,
    belongsToExtension,
    canonicalBuiltinId,
    InvalidCommandPayloadError,
    UnknownCommandError,
    type CommandContribution,
    type CommandKeybinding,
    type CommandRegistry,
    type Disposable,
    type KeybindingContribution,
    type RegisteredCommand,
} from "../../extension-api"

export interface HostCommandMetadata {
    readonly allowInInputs?: boolean
    readonly preventDefault?: boolean
    readonly shouldHandleKey?: (event: KeyboardEvent) => boolean
    readonly keyboardPayload?: (event: KeyboardEvent) => unknown
    readonly isEnabled?: (context?: unknown) => boolean | Promise<boolean>
}

export interface HostKeybinding extends HostCommandMetadata, CommandKeybinding {
    readonly when?: (context?: unknown) => boolean
}

export interface HostCommandFacade {
    get(commandId: string): RegisteredCommand | undefined
    list(): readonly RegisteredCommand[]
    listKeybindings(): readonly HostKeybinding[]
    execute(commandId: string, payload?: unknown, context?: unknown): Promise<unknown>
}

/** Normalize host keybindings before comparing declarations or keyboard events. */
export function normalizeKeybinding(keybinding: string): string {
    return KeyboardHandler.normalize(keybinding)
}

export async function resolveHostKeybindings(
    bindings: readonly HostKeybinding[],
    event: KeyboardEvent,
): Promise<readonly HostKeybinding[]> {
    const focusedInput = isFocusedInputTarget(event.target)
    const eligible: HostKeybinding[] = []
    for (const binding of bindings) {
        if (focusedInput && binding.allowInInputs !== true) continue
        if (binding.shouldHandleKey && !binding.shouldHandleKey(event)) continue
        if (binding.isEnabled && !(await binding.isEnabled(event))) continue
        eligible.push(binding)
    }
    return eligible
}

export function isFocusedInputTarget(target: EventTarget | null): boolean {
    if (!target || typeof target !== "object") return false
    const element = target as {
        tagName?: string
        isContentEditable?: boolean
        closest?: (selector: string) => unknown
    }
    return (
        ["INPUT", "TEXTAREA", "SELECT"].includes(element.tagName?.toUpperCase() ?? "") ||
        element.isContentEditable === true ||
        Boolean(element.closest?.("input, textarea, select, [contenteditable='true']"))
    )
}

export function findKeybindingConflicts(
    bindings: readonly HostKeybinding[],
): readonly (readonly [string, readonly HostKeybinding[]])[] {
    const grouped = new Map<string, HostKeybinding[]>()
    for (const binding of bindings) {
        const key = normalizeKeybinding(binding.keybinding)
        const entries = grouped.get(key) ?? []
        entries.push(binding)
        grouped.set(key, entries)
    }
    return [...grouped.entries()]
        .filter(([, entries]) => entries.length > 1)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entries]) => [
            key,
            [...entries].sort(
                (left, right) =>
                    left.extensionId.localeCompare(right.extensionId) ||
                    left.commandId.localeCompare(right.commandId) ||
                    left.keybinding.localeCompare(right.keybinding),
            ),
        ])
}

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

    listKeybindings(): readonly HostKeybinding[] {
        const registered = [...this.keybindings.entries()].flatMap(([commandId, bindings]) =>
            bindings.map((binding) => ({
                ...binding,
                ...metadataForCommand(this.commands.get(commandId)),
                keybinding: binding.keybinding.join("+"),
                extensionId: this.extensionId,
            })),
        )
        const contributed = [...this.commands.values()].flatMap((command) =>
            (command.keybinding ?? []).map((keybinding) => ({
                commandId: command.id,
                keybinding,
                ...metadataForCommand(command),
                extensionId: this.extensionId,
            })),
        )
        return [...registered, ...contributed]
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

function metadataForCommand(command: RegisteredCommand | undefined): HostCommandMetadata {
    if (!command) return {}
    const metadata = command as RegisteredCommand & HostCommandMetadata
    return {
        ...(metadata.allowInInputs === undefined ? {} : { allowInInputs: metadata.allowInInputs }),
        ...(metadata.preventDefault === undefined
            ? {}
            : { preventDefault: metadata.preventDefault }),
        ...(metadata.shouldHandleKey === undefined
            ? {}
            : { shouldHandleKey: metadata.shouldHandleKey }),
        ...(metadata.keyboardPayload === undefined
            ? {}
            : { keyboardPayload: metadata.keyboardPayload }),
        ...(metadata.isEnabled === undefined ? {} : { isEnabled: metadata.isEnabled }),
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
