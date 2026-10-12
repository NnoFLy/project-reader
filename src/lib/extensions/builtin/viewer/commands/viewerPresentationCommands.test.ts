import { describe, expect, it, vi } from "vitest"
import { createViewerFitWidthCommand } from "./viewerFitWidthCommand"
import { createViewerListCommands } from "./viewerListCommands"
import { createViewerOutlineCommands } from "./viewerOutlineCommands"
import { createViewerSidebarCloseCommand } from "./viewerSidebarCloseCommand"

const callbacks = {
    disabled: () => false,
    shouldHandleNavigationKey: () => true,
    next: vi.fn(),
    previous: vi.fn(),
    select: vi.fn(),
    search: vi.fn(),
}

function expectAliases(commands: { id: string; englishLabel?: () => string }[]) {
    for (const command of commands) {
        expect(command.englishLabel?.().trim(), command.id).toBeTruthy()
    }
}

describe("viewer presentation command aliases", () => {
    it("covers list and outline keyboard-help commands", () => {
        expectAliases(
            createViewerListCommands({
                nextLabel: () => "Следующая заметка",
                nextEnglishLabel: () => "Next note",
                previousLabel: () => "Предыдущая заметка",
                previousEnglishLabel: () => "Previous note",
                selectLabel: () => "Открыть заметку",
                selectEnglishLabel: () => "Open note",
                searchLabel: () => "Искать заметки",
                searchEnglishLabel: () => "Search notes",
                ...callbacks,
            }),
        )
        expectAliases(
            createViewerOutlineCommands({
                nextLabel: () => "Следующий заголовок",
                nextEnglishLabel: () => "Next heading",
                previousLabel: () => "Предыдущий заголовок",
                previousEnglishLabel: () => "Previous heading",
                selectLabel: () => "Выбрать заголовок",
                selectEnglishLabel: () => "Select heading",
                searchLabel: () => "Поиск по оглавлению",
                searchEnglishLabel: () => "Search headings",
                ...callbacks,
            }),
        )
    })

    it("covers sidebar and fit-width commands", () => {
        expectAliases([
            createViewerSidebarCloseCommand({
                label: () => "Закрыть боковую панель",
                englishLabel: () => "Close sidebar",
                disabled: () => false,
                shouldHandleKey: () => true,
                close: vi.fn(),
            }),
            createViewerFitWidthCommand(vi.fn()),
        ])
    })
})
