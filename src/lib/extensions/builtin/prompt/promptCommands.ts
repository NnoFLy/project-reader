import { defineCommands } from "$lib/core/commands"
import * as m from "$lib/paraglide/messages"

export interface PromptCommandActions {
    close: () => void
    next: () => void
    previous: () => void
    select: () => void | Promise<void>
    navigateBack: () => void
    canNavigateBack: () => boolean
    historyBack: () => void
    historyForward: () => void
}

export function createPromptCommands(actions: PromptCommandActions) {
    return defineCommands({
        "prompt.close": {
            id: "prompt.close",
            keymap: ["escape", "ctrl+[", "ctrl+c", "ctrl+g"],
            label: () => m.prompt_close_aria(),
            englishLabel: () => m.prompt_close_aria({}, { locale: "en" }),
            category: "navigation",
            palette: false,
            allowInInputs: true,
            run: actions.close,
        },
        "prompt.next": {
            id: "prompt.next",
            keymap: ["arrowdown", "ctrl+n", "ctrl+j"],
            label: () => m.keymap_prompt_next(),
            englishLabel: () => m.keymap_prompt_next({}, { locale: "en" }),
            category: "navigation",
            palette: false,
            allowInInputs: true,
            run: actions.next,
        },
        "prompt.previous": {
            id: "prompt.previous",
            keymap: ["arrowup", "ctrl+p", "ctrl+k"],
            label: () => m.keymap_prompt_previous(),
            englishLabel: () => m.keymap_prompt_previous({}, { locale: "en" }),
            category: "navigation",
            palette: false,
            allowInInputs: true,
            run: actions.previous,
        },
        "prompt.select": {
            id: "prompt.select",
            keymap: "enter",
            label: () => m.keymap_prompt_select(),
            englishLabel: () => m.keymap_prompt_select({}, { locale: "en" }),
            category: "navigation",
            palette: false,
            allowInInputs: true,
            run: actions.select,
        },
        "prompt.navigate.back": {
            id: "prompt.navigate.back",
            keymap: "backspace",
            label: () => m.keymap_prompt_back(),
            englishLabel: () => m.keymap_prompt_back({}, { locale: "en" }),
            category: "navigation",
            palette: false,
            allowInInputs: true,
            disabled: () => !actions.canNavigateBack(),
            run: actions.navigateBack,
        },
        "prompt.history.back": {
            id: "prompt.history.back",
            keymap: "alt+p",
            label: () => m.keymap_prompt_history_back(),
            englishLabel: () => m.keymap_prompt_history_back({}, { locale: "en" }),
            category: "navigation",
            palette: false,
            allowInInputs: true,
            run: actions.historyBack,
        },
        "prompt.history.forward": {
            id: "prompt.history.forward",
            keymap: "alt+n",
            label: () => m.keymap_prompt_history_forward(),
            englishLabel: () => m.keymap_prompt_history_forward({}, { locale: "en" }),
            category: "navigation",
            palette: false,
            allowInInputs: true,
            run: actions.historyForward,
        },
    })
}
