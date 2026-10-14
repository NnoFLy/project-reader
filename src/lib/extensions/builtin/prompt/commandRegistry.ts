import type { CommandRegistry } from "$lib/extension-api"

export type PromptCommandRegistry = Pick<
    CommandRegistry,
    "get" | "list" | "listKeybindings" | "execute"
>

let injectedRegistry: PromptCommandRegistry | undefined

/** Inject the host registry used by prompt-owned command discovery. */
export function setPromptCommandRegistry(registry: PromptCommandRegistry | undefined): void {
    injectedRegistry = registry
}

export function getPromptCommandRegistry(): PromptCommandRegistry | undefined {
    return injectedRegistry
}
