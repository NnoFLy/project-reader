import { defineCommands } from "$lib/modules/commands"

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
            label: () => "Close prompt",
            category: "navigation",
            palette: false,
            allowInInputs: true,
            run: actions.close,
        },
        "prompt.next": {
            id: "prompt.next",
            keymap: ["arrowdown", "ctrl+n", "ctrl+j"],
            label: () => "Next prompt result",
            category: "navigation",
            palette: false,
            allowInInputs: true,
            run: actions.next,
        },
        "prompt.previous": {
            id: "prompt.previous",
            keymap: ["arrowup", "ctrl+p", "ctrl+k"],
            label: () => "Previous prompt result",
            category: "navigation",
            palette: false,
            allowInInputs: true,
            run: actions.previous,
        },
        "prompt.select": {
            id: "prompt.select",
            keymap: "enter",
            label: () => "Select prompt result",
            category: "navigation",
            palette: false,
            allowInInputs: true,
            run: actions.select,
        },
        "prompt.navigate.back": {
            id: "prompt.navigate.back",
            keymap: "backspace",
            label: () => "Return to previous prompt",
            category: "navigation",
            palette: false,
            allowInInputs: true,
            disabled: () => !actions.canNavigateBack(),
            run: actions.navigateBack,
        },
        "prompt.history.back": {
            id: "prompt.history.back",
            keymap: "alt+p",
            label: () => "Prompt history back",
            category: "navigation",
            palette: false,
            allowInInputs: true,
            run: actions.historyBack,
        },
        "prompt.history.forward": {
            id: "prompt.history.forward",
            keymap: "alt+n",
            label: () => "Prompt history forward",
            category: "navigation",
            palette: false,
            allowInInputs: true,
            run: actions.historyForward,
        },
    })
}
