import type { ExtensionContext } from "$lib/extension-api"

export const PROMPT_VIEW_ID = "prompt.palette"

export function activatePrompt(context: ExtensionContext): void {
    context.views.register({
        id: PROMPT_VIEW_ID,
        slot: "prompt.result",
        title: "Command palette",
    })
}
