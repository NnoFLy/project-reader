import type { PromptService } from "../commands/prompt.types"

export interface LibraryHostBridge {
    readonly execute: (commandId: string, payload?: unknown) => Promise<unknown>
    readonly prompt: PromptService
}

let hostBridge: LibraryHostBridge | undefined

export function configureLibraryHostBridge(bridge: LibraryHostBridge | undefined): void {
    hostBridge = bridge
}

export function getLibraryHostBridge(): LibraryHostBridge | undefined {
    return hostBridge
}

export async function executeLibraryHostCommand(
    commandId: string,
    payload?: unknown,
): Promise<unknown> {
    const bridge = getLibraryHostBridge()
    if (!bridge) return undefined
    return bridge.execute(commandId, payload)
}

export function getLibraryPrompt(): PromptService | undefined {
    return getLibraryHostBridge()?.prompt
}
