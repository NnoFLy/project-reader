export { default as KeymapHelp } from "./components/KeymapHelp.svelte"
export { default as Prompt } from "./components/Prompt.svelte"
export { default as PromptItemComponent } from "./components/PromptItem.svelte"
export { openCommandPalette } from "./commands/commandPalette"
export { getPromptCommandRegistry, setPromptCommandRegistry } from "./commandRegistry"
export { buildKeymapHelpItems, filterKeymapHelpItems } from "./keymapHelp"
export { createPromptCommands } from "./promptCommands"
export type { KeymapHelpItem, KeymapHelpSource } from "./keymapHelp"
export type {
    PromptItem,
    PromptItemPresentation,
    PromptItems,
    PromptRequest,
    PromptSelectionBehavior,
    PromptSelectionControls,
    PromptService,
    PromptSnapshot,
} from "./prompt.types"
export type { PromptCommandActions } from "./promptCommands"
export { promptStore } from "./stores/promptStore.svelte"

import type { ExtensionContext } from "$lib/extension-api"
import { isSerializablePayload, serializablePayload } from "$lib/modules/commands"
import { openCommandPalette } from "./commands/commandPalette"
import Prompt from "./components/Prompt.svelte"
import { setPromptCommandRegistry } from "./commandRegistry"
import { promptStore } from "./stores/promptStore.svelte"

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
    context.lifecycle.onDispose(() => {
        promptStore.reset()
        setPromptCommandRegistry(undefined)
    })

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
