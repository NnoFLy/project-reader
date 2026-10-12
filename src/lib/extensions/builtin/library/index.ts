import type { AnyCommandDefinition } from "./commands/commands.types"
import type { CommandContribution, ExtensionContext } from "$lib/extension-api"
import LibraryPage from "./LibraryPage.svelte"
import { createLibraryCommands } from "./commands/libraryCommands"
import {
    configureLibraryUIController,
    configureLibraryUIStorage,
    LibraryUIController,
} from "./state/libraryUI.svelte"
import { configurePromptStorage } from "./commands/promptStore.svelte"
import { libraryStore } from "./state/libraryStore.svelte"
import { configureLibraryNotifications } from "./state/libraryNotifications"
import { migrateLegacyDatabaseToLibrary } from "$lib/modules/documents"

export { LibraryPage }
export { default as LibraryRelinkHost } from "./components/LibraryRelinkHost.svelte"
export { requestLibraryRelink } from "./state/relinkRequest.svelte"
export { createLibraryCommands, libraryBookOpenCommand } from "./commands/libraryCommands"
export { libraryStore } from "./state/libraryStore.svelte"
export type * from "./state/libraryStore.types"

export const LIBRARY_VIEW_ID = "library.page"

export async function activateLibrary(context: ExtensionContext): Promise<void> {
    const libraryStorage = context.storage.namespace("library")
    await migrateLegacyDatabaseToLibrary(libraryStorage)
    libraryStore.configureStorage(libraryStorage)
    configureLibraryUIStorage(libraryStorage)
    configurePromptStorage(libraryStorage)
    configureLibraryNotifications((message, level = "info") => {
        context.notifications[level](message)
    })

    const libraryUI = new LibraryUIController()
    configureLibraryUIController(libraryUI)
    const commands = createLibraryCommands(libraryUI)
    const registrations = Object.values(commands).map((value) => {
        const command = value as AnyCommandDefinition
        const contribution: CommandContribution = {
            id: command.id,
            label: command.label,
            keybinding: command.keymap
                ? Array.isArray(command.keymap)
                    ? command.keymap
                    : [command.keymap]
                : undefined,
            execute: (payload) => command.run(payload as never),
            isEnabled: () => !command.disabled?.(),
        }
        return context.commands.register(contribution)
    })
    context.lifecycle.onDispose(() => {
        for (const registration of registrations) registration.dispose()
        configureLibraryUIController(undefined)
        configurePromptStorage(undefined)
    })

    context.views.registerNative({
        id: LIBRARY_VIEW_ID,
        slot: "workbench.panel",
        title: "Library",
        kind: "native",
        component: LibraryPage,
    })
}
