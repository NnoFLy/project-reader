import type { CommandRegistry } from "$lib/extension-api"

let injectedRegistry: CommandRegistry | undefined

/** Inject the core registry owned by the active Prompt extension. */
export function setPromptCommandRegistry(registry: CommandRegistry | undefined): void {
    injectedRegistry = registry
}

export function getPromptCommandRegistry(): CommandRegistry | undefined {
    return injectedRegistry
}
