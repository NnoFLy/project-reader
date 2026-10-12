import type { ExtensionContext } from "$lib/extension-api"
import { Prompt } from "$lib/modules/prompt"

export const PROMPT_VIEW_ID = "prompt.palette"

export function activatePrompt(context: ExtensionContext): void {
    context.views.registerNative({
        id: PROMPT_VIEW_ID,
        slot: "prompt.result",
        title: "Command palette",
        kind: "native",
        component: Prompt,
    })
}
