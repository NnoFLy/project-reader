import type { ExtensionContext } from "$lib/extension-api"
import { isSerializablePayload, serializablePayload } from "$lib/modules/commands"
import {
    openCommandPalette,
    Prompt,
    setPromptCommandRegistry,
    promptStore,
} from "$lib/modules/prompt"

export const PROMPT_VIEW_ID = "prompt.palette"

interface PromptOpenPayload {
    initialQuery?: string
}

function isPromptOpenPayload(payload: unknown): payload is PromptOpenPayload | undefined {
    if (payload === undefined) return true
    if (!isSerializablePayload(payload) || typeof payload !== "object" || payload === null) {
        return false
    }
    const value = payload as { readonly initialQuery?: unknown }
    return value.initialQuery === undefined || typeof value.initialQuery === "string"
}

export function activatePrompt(context: ExtensionContext): void {
    setPromptCommandRegistry(context.commands)
    context.lifecycle.onDispose(() => setPromptCommandRegistry(undefined))

    context.commands.register({
        id: "prompt.open",
        label: "Open command palette",
        keybinding: ["ctrl+k", "meta+k"],
        validatePayload: serializablePayload(isPromptOpenPayload),
        execute: (payload) =>
            openCommandPalette(
                context.commands,
                (payload as PromptOpenPayload | undefined)?.initialQuery,
            ),
    })
    context.commands.register({
        id: "prompt.close",
        label: "Close prompt",
        execute: () => promptStore.close(),
    })
    context.views.registerNative({
        id: PROMPT_VIEW_ID,
        slot: "prompt.result",
        title: "Command palette",
        kind: "native",
        component: Prompt,
    })
}
