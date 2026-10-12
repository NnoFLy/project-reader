import { getContext, onMount, setContext } from "svelte"
import type { CommandId, ExecuteArgs } from "./appCommandPayloads"
import type {
    ActiveCommand,
    AnyCommandDefinition,
    CommandCategory,
    CommandExecutionResult,
    CommandDefinitions,
} from "./commands.types"
import { dismissFocusedInteractiveElement } from "$lib/shared/ui/modal/modalFocus"
import { KeyboardHandler } from "./keyboard"
export { KeyboardHandler } from "./keyboard"

type StoredCommand = {
    id: string
    keymap?: string | string[]
    label: () => string
    englishLabel?: () => string
    category: CommandCategory
    subtitle?: () => string
    disabled: () => boolean
    allowInInputs: boolean
    dismissFocusedElement: boolean
    preventDefault: boolean
    palette: () => boolean
    definition: AnyCommandDefinition
}

type ResolvedCommand = {
    command: StoredCommand
    ownerScope: CommandScope
    keymap?: string | string[]
}

function keysOf(keymap?: string | string[]): string[] {
    if (!keymap) return []
    return Array.isArray(keymap) ? keymap : [keymap]
}

function normalizeDefinition(command: AnyCommandDefinition): StoredCommand {
    const normalized = (Array.isArray(command.keymap) ? command.keymap : [command.keymap])
        .filter((key): key is string => key !== undefined)
        .map(KeyboardHandler.normalize)
    const palette = command.palette
    return {
        id: command.id,
        keymap: Array.isArray(command.keymap) ? normalized : normalized[0],
        label: command.label,
        englishLabel: command.englishLabel,
        category: command.category,
        subtitle: command.subtitle,
        disabled: command.disabled ?? (() => false),
        allowInInputs: command.allowInInputs ?? false,
        dismissFocusedElement: command.dismissFocusedElement ?? false,
        preventDefault: command.preventDefault ?? true,
        palette: typeof palette === "function" ? palette : () => palette ?? true,
        definition: command,
    }
}

function assertNoDuplicates(existing: StoredCommand[], additions: StoredCommand[]) {
    const ids = new Set(existing.map((command) => command.id))
    const keys = new Set(existing.flatMap((command) => keysOf(command.keymap)))
    for (const command of additions) {
        if (ids.has(command.id)) {
            throw new Error(`Command ${command.id} is already registered in this scope`)
        }
        ids.add(command.id)
        for (const key of keysOf(command.keymap)) {
            if (keys.has(key)) {
                throw new Error(`Key ${key} is already registered in this scope`)
            }
            keys.add(key)
        }
    }
}

export class CommandScope {
    parent = $state.raw<CommandScope | null>(null)
    private commands = $state.raw<StoredCommand[]>([])
    private destroyCallbacks = new Set<() => void>()
    isDestroyed = $state(false)
    readonly keyboardBoundary: boolean

    constructor(parent: CommandScope | null = null, keyboardBoundary = false) {
        this.parent = parent
        this.keyboardBoundary = keyboardBoundary
    }

    private resolveActive(): ResolvedCommand[] {
        if (this.isDestroyed) return []
        const active: ResolvedCommand[] = []
        const seenIds = new Set<string>()
        const seenKeys = new Set<string>()
        // eslint-disable-next-line @typescript-eslint/no-this-alias
        let current: CommandScope | null = this
        while (current) {
            if (!current.isDestroyed) {
                for (const command of current.commands) {
                    if (command.disabled() || seenIds.has(command.id)) continue
                    seenIds.add(command.id)
                    const availableKeys = keysOf(command.keymap).filter((key) => !seenKeys.has(key))
                    availableKeys.forEach((key) => seenKeys.add(key))
                    let keymap: string | string[] | undefined
                    if (availableKeys.length > 0) {
                        keymap = Array.isArray(command.keymap) ? availableKeys : availableKeys[0]
                    }
                    active.push({ command, ownerScope: current, keymap })
                }
            }
            current = current.parent
        }
        return active
    }

    private resolveById(id: string): ResolvedCommand | undefined {
        if (this.isDestroyed) return undefined
        // eslint-disable-next-line @typescript-eslint/no-this-alias
        let current: CommandScope | null = this
        while (current) {
            if (!current.isDestroyed) {
                const command = current.commands.find((candidate) => candidate.id === id)
                if (command && !command.disabled()) {
                    return { command, ownerScope: current, keymap: command.keymap }
                }
            }
            current = current.parent
        }
        return undefined
    }

    register(command: AnyCommandDefinition) {
        return this.registerAll([command])
    }

    registerAll(commands: readonly AnyCommandDefinition[]) {
        if (this.isDestroyed) throw new Error("Cannot register commands on a destroyed scope")
        const normalized = commands.map(normalizeDefinition)
        assertNoDuplicates(this.commands, normalized)
        this.commands = [...this.commands, ...normalized]
        return () => {
            this.commands = this.commands.filter((command) => !normalized.includes(command))
        }
    }

    listActive(): ActiveCommand[] {
        return this.toActiveCommands(this.resolveActive())
    }

    listPaletteCommands(): ActiveCommand[] {
        return this.toActiveCommands(
            this.resolveActive().filter(({ command }) => command.palette()),
        )
    }

    private toActiveCommands(resolvedCommands: ResolvedCommand[]): ActiveCommand[] {
        return resolvedCommands.map(({ command, ownerScope, keymap }) => ({
            id: command.definition.id,
            label: command.label(),
            englishLabel: command.englishLabel?.(),
            category: command.category,
            keymap,
            subtitle: command.subtitle?.(),
            onUnavailable: (callback: () => void) => {
                const stopCaptured = this.onDestroy(callback)
                const stopOwner =
                    ownerScope === this ? () => undefined : ownerScope.onDestroy(callback)
                return () => {
                    stopCaptured()
                    stopOwner()
                }
            },
            execute: (...args: unknown[]) =>
                this.executeResolved(
                    ownerScope,
                    command,
                    args[0],
                ) as Promise<CommandExecutionResult>,
        }))
    }

    get<K extends CommandId>(id: K): ActiveCommand<K> | undefined {
        const resolved = this.resolveById(id)
        if (!resolved) return undefined
        return this.toActiveCommands([resolved])[0] as unknown as ActiveCommand<K>
    }

    canExecute<K extends CommandId>(id: K): boolean {
        return this.resolveById(id) !== undefined
    }

    getShortcut<K extends CommandId>(id: K): string | string[] | undefined {
        return this.resolveById(id)?.keymap
    }

    async execute<K extends CommandId>(
        id: K,
        ...args: ExecuteArgs<K>
    ): Promise<CommandExecutionResult> {
        let foundDisabled = false
        // eslint-disable-next-line @typescript-eslint/no-this-alias
        let current: CommandScope | null = this
        while (current) {
            if (!current.isDestroyed) {
                const command = current.commands.find((candidate) => candidate.id === id)
                if (command) {
                    if (command.disabled()) {
                        foundDisabled = true
                    } else if (command.definition) {
                        return this.executeResolved(current, command, args[0], true)
                    }
                }
            }
            current = current.parent
        }
        return foundDisabled ? { status: "disabled", id } : { status: "unavailable", id }
    }

    private async executeResolved(
        ownerScope: CommandScope,
        command: StoredCommand,
        payload: unknown,
        availabilityChecked = false,
    ): Promise<CommandExecutionResult> {
        const id = command.id as CommandId
        if (this.isDestroyed || ownerScope.isDestroyed || !ownerScope.commands.includes(command)) {
            return { status: "unavailable", id }
        }
        if (!availabilityChecked && command.disabled()) return { status: "disabled", id }
        await command.definition.run(payload as never)
        return { status: "executed", id: command.definition.id }
    }

    isAncestorOf(other: CommandScope | null): boolean {
        let current = other
        while (current) {
            if (current === this) return true
            current = current.parent
        }
        return false
    }

    handleKeydown(event: KeyboardEvent) {
        void commandsStore.handleKeydown(event, this)
    }

    resolveForKeyboard(event: KeyboardEvent): ResolvedCommand | undefined {
        const candidates = KeyboardHandler.candidates(event)
        // eslint-disable-next-line @typescript-eslint/no-this-alias
        let current: CommandScope | null = this
        while (current) {
            if (!current.isDestroyed) {
                for (const command of current.commands) {
                    if (
                        !command.keymap ||
                        !KeyboardHandler.matchesCandidates(candidates, keysOf(command.keymap))
                    )
                        continue
                    if (!command.disabled()) return { command, ownerScope: current }
                }
            }
            if (current.keyboardBoundary) break
            current = current.parent
        }
        return undefined
    }

    executeKeyboard(resolved: ResolvedCommand, payload: unknown) {
        return this.executeResolved(resolved.ownerScope, resolved.command, payload)
    }

    onDestroy(callback: () => void) {
        if (this.isDestroyed) {
            callback()
            return () => undefined
        }
        this.destroyCallbacks.add(callback)
        return () => this.destroyCallbacks.delete(callback)
    }

    destroy() {
        if (this.isDestroyed) return
        this.isDestroyed = true
        this.commands = []
        for (const callback of this.destroyCallbacks) callback()
        this.destroyCallbacks.clear()
        commandsStore.deactivate(this)
    }
}

export class CommandsStore {
    readonly root = new CommandScope()
    #activeScope = $state.raw<CommandScope>(this.root)
    private activationStack: CommandScope[] = [this.root]

    get activeScope() {
        return this.#activeScope
    }

    set activeScope(scope: CommandScope | null) {
        this.activate(scope ?? this.root)
    }

    activate(scope: CommandScope) {
        if (scope.isDestroyed) return
        this.activationStack = this.activationStack.filter(
            (candidate) => candidate !== scope && !candidate.isDestroyed,
        )
        this.activationStack.push(scope)
        this.#activeScope = scope
    }

    deactivate(scope: CommandScope) {
        this.activationStack = this.activationStack.filter((candidate) => candidate !== scope)
        this.#activeScope =
            this.activationStack.toReversed().find((candidate) => !candidate.isDestroyed) ??
            this.root
    }

    createScope(
        parent: CommandScope | null = this.#activeScope,
        options?: { keyboardBoundary?: boolean },
    ) {
        return new CommandScope(parent, options?.keyboardBoundary)
    }

    register(
        scope: CommandScope,
        definitions: CommandDefinitions | readonly AnyCommandDefinition[],
    ) {
        const commands = Array.isArray(definitions)
            ? definitions
            : (Object.values(definitions).filter(Boolean) as AnyCommandDefinition[])
        return scope.registerAll(commands)
    }

    execute<K extends CommandId>(id: K, ...args: ExecuteArgs<K>) {
        return this.#activeScope.execute(id, ...args)
    }

    canExecute<K extends CommandId>(id: K) {
        return this.#activeScope.canExecute(id)
    }

    get<K extends CommandId>(id: K) {
        return this.#activeScope.get(id)
    }

    listActive() {
        return this.#activeScope.listActive()
    }

    listPaletteCommands() {
        return this.#activeScope.listPaletteCommands()
    }

    getShortcut<K extends CommandId>(id: K) {
        return this.#activeScope.getShortcut(id)
    }

    async handleKeydown(event: KeyboardEvent, scope = this.#activeScope) {
        const resolved = scope.resolveForKeyboard(event)
        if (!resolved) return
        const { command } = resolved
        const target = event.target as HTMLElement | null
        const isInput =
            target &&
            (target.tagName === "INPUT" ||
                target.tagName === "TEXTAREA" ||
                target.isContentEditable)
        if (isInput && !command.allowInInputs) return
        if (command.definition.shouldHandleKey && !command.definition.shouldHandleKey(event)) return
        if (
            command.dismissFocusedElement &&
            KeyboardHandler.matches(event, "escape") &&
            dismissFocusedInteractiveElement()
        ) {
            event.preventDefault()
            event.stopImmediatePropagation()
            return
        }
        if (command.preventDefault) event.preventDefault()
        const payload = command.definition.keyboardPayload?.(event)
        await scope.executeKeyboard(resolved, payload)
    }
}

export const commandsStore = new CommandsStore()

export const COMMANDS_CONTEXT_KEY = Symbol("commands-context")

export function useCommands(
    definitions: readonly AnyCommandDefinition[],
    overrideParent?: CommandScope | null,
    options?: {
        registerOnParent?: boolean
        autoActivate?: boolean
        keyboardBoundary?: boolean
    },
) {
    const parent =
        overrideParent !== undefined
            ? (overrideParent ?? commandsStore.root)
            : (getContext<CommandScope>(COMMANDS_CONTEXT_KEY) ?? commandsStore.root)

    if (options?.registerOnParent) {
        onMount(() => parent.registerAll(definitions))
        return parent
    }

    const scope = commandsStore.createScope(parent, {
        keyboardBoundary: options?.keyboardBoundary,
    })
    setContext(COMMANDS_CONTEXT_KEY, scope)

    onMount(() => {
        if (options?.autoActivate !== false && !scope.isAncestorOf(commandsStore.activeScope)) {
            commandsStore.activate(scope)
        }
        const unregister = scope.registerAll(definitions)
        return () => {
            unregister()
            scope.destroy()
        }
    })
    return scope
}

export function getPrimaryKeysString(keys: string | string[]): string {
    if (Array.isArray(keys)) return keys.find((key) => key.includes("arrow")) ?? keys[0] ?? ""
    return keys
}

export function getRawShortcutHint(scope: CommandScope | null, id: CommandId): string {
    const keymap = scope?.getShortcut(id)
    return keymap ? KeyboardHandler.format(getPrimaryKeysString(keymap)) : ""
}

export function getShortcutHint(scope: CommandScope | null, ...ids: CommandId[]): string {
    const shortcuts = ids.map((id) => getRawShortcutHint(scope, id)).filter(Boolean)
    return shortcuts.length ? ` [${shortcuts.join("/")}]` : ""
}

export function formatKeyString(keys: string | string[]): string {
    return KeyboardHandler.format(keys)
}

export { defineCommands } from "./commands.types"
export { useModalCommands } from "./useModalCommands.svelte"
