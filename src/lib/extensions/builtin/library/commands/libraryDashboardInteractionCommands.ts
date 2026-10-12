import { defineCommands, type AnyCommandDefinition } from "$lib/modules/commands"

interface LibraryDashboardInteractionCommandOptions {
    gridDisabled: () => boolean
    moveGrid: (direction: "up" | "down" | "left" | "right", repeated: boolean) => void
    startOpenPicker: () => void
    startFocusPicker: () => void
    startSelectionPicker: () => void
    goUpFolder: () => void
    decreaseCardSize: () => void
    increaseCardSize: () => void
    cardSizeDecreaseDisabled: () => boolean
    cardSizeIncreaseDisabled: () => boolean
    labels: {
        down: () => string
        up: () => string
        left: () => string
        right: () => string
        openPicker: () => string
        focusPicker: () => string
        selectionPicker: () => string
        upFolder: () => string
        cardSizeDecrease: () => string
        cardSizeIncrease: () => string
    }
    englishLabels: {
        down: () => string
        up: () => string
        left: () => string
        right: () => string
        openPicker: () => string
        focusPicker: () => string
        selectionPicker: () => string
        upFolder: () => string
        cardSizeDecrease: () => string
        cardSizeIncrease: () => string
    }
}

export function createLibraryDashboardInteractionCommands(
    options: LibraryDashboardInteractionCommandOptions,
): AnyCommandDefinition[] {
    const gridCommand = (
        id: "library.grid.down" | "library.grid.up" | "library.grid.left" | "library.grid.right",
        keymap: string[],
        label: () => string,
        englishLabel: () => string,
        direction: "up" | "down" | "left" | "right",
    ) => ({
        id,
        keymap,
        label,
        englishLabel,
        category: "navigation" as const,
        disabled: options.gridDisabled,
        keyboardPayload: (event: KeyboardEvent) => ({ repeated: event.repeat }),
        run: (payload: { repeated?: boolean } | undefined) =>
            options.moveGrid(direction, payload?.repeated ?? false),
    })

    return [
        gridCommand(
            "library.grid.down",
            ["j", "arrowdown"],
            options.labels.down,
            options.englishLabels.down,
            "down",
        ),
        gridCommand(
            "library.grid.up",
            ["k", "arrowup"],
            options.labels.up,
            options.englishLabels.up,
            "up",
        ),
        gridCommand(
            "library.grid.left",
            ["h", "arrowleft"],
            options.labels.left,
            options.englishLabels.left,
            "left",
        ),
        gridCommand(
            "library.grid.right",
            ["l", "arrowright"],
            options.labels.right,
            options.englishLabels.right,
            "right",
        ),
        ...Object.values(
            defineCommands({
                "library.picker.open": {
                    id: "library.picker.open",
                    keymap: "f",
                    label: options.labels.openPicker,
                    englishLabel: options.englishLabels.openPicker,
                    category: "commands",
                    run: options.startOpenPicker,
                },
                "library.picker.focus": {
                    id: "library.picker.focus",
                    keymap: "v",
                    label: options.labels.focusPicker,
                    englishLabel: options.englishLabels.focusPicker,
                    category: "commands",
                    run: options.startFocusPicker,
                },
                "library.picker.select": {
                    id: "library.picker.select",
                    keymap: "s",
                    label: options.labels.selectionPicker,
                    englishLabel: options.englishLabels.selectionPicker,
                    category: "commands",
                    run: options.startSelectionPicker,
                },
                "library.folder.up": {
                    id: "library.folder.up",
                    keymap: "backspace",
                    label: options.labels.upFolder,
                    englishLabel: options.englishLabels.upFolder,
                    category: "navigation",
                    run: options.goUpFolder,
                },
                "library.card-size.decrease": {
                    id: "library.card-size.decrease",
                    keymap: "-",
                    label: options.labels.cardSizeDecrease,
                    englishLabel: options.englishLabels.cardSizeDecrease,
                    category: "navigation",
                    disabled: options.cardSizeDecreaseDisabled,
                    preventDefault: true,
                    run: options.decreaseCardSize,
                },
                "library.card-size.increase": {
                    id: "library.card-size.increase",
                    keymap: ["+", "="],
                    label: options.labels.cardSizeIncrease,
                    englishLabel: options.englishLabels.cardSizeIncrease,
                    category: "navigation",
                    disabled: options.cardSizeIncreaseDisabled,
                    preventDefault: true,
                    run: options.increaseCardSize,
                },
            }),
        ).filter(Boolean),
    ] as AnyCommandDefinition[]
}
