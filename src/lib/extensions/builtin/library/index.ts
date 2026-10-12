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
import type { PromptService } from "./commands/prompt.types"
import { configureLibraryStore, installDocumentService } from "./state/libraryStore.svelte"
import { configureLibraryNotifications } from "./state/libraryNotifications"
import { configureLibraryHostBridge } from "./state/libraryHostBridge"

export { LibraryPage }
export { default as LibraryRelinkHost } from "./components/LibraryRelinkHost.svelte"
export { requestLibraryRelink } from "./state/relinkRequest.svelte"
export { createLibraryCommands, libraryBookOpenCommand } from "./commands/libraryCommands"
export { libraryStore } from "./state/libraryStore.svelte"
export type * from "./state/libraryStore.types"

export const LIBRARY_VIEW_ID = "library.page"

export async function activateLibrary(
    context: ExtensionContext,
    prompt?: PromptService,
    onDispose?: () => void,
): Promise<void> {
    const libraryStorage = context.storage.namespace("library")
    await context.migration?.migrateLibrary(libraryStorage)
    const store = configureLibraryStore(libraryStorage)
    configureLibraryUIStorage(libraryStorage)
    configurePromptStorage(libraryStorage)
    configureLibraryHostBridge({
        prompt: prompt ?? {
            choose: async () => undefined,
            open: async () => undefined,
            close: () => undefined,
            setQuery: () => undefined,
            refresh: () => undefined,
            snapshot: null,
            isOpen: false,
            query: "",
        },
        execute: (commandId, payload) => context.commands.execute(commandId, payload),
    })
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
    context.lifecycle.onDispose(async () => {
        for (const registration of registrations) registration.dispose()
        configureLibraryUIController(undefined)
        configureLibraryHostBridge(undefined)
        configurePromptStorage(undefined)
        configureLibraryNotifications(undefined)
        installDocumentService(undefined)
        onDispose?.()
        await store.dispose()
    })

    context.views.registerNative({
        id: LIBRARY_VIEW_ID,
        slot: "workbench.panel",
        title: "Library",
        kind: "native",
        component: LibraryPage,
    })
}
