import type { AnyCommandDefinition } from "./commands/commands.types"
import type { HostCommandMetadata } from "$lib/core/commands"
import type { CommandContribution, ExtensionContext } from "$lib/extension-api"
import LibraryPage from "./LibraryPage.svelte"
import LibraryStatus from "./LibraryStatus.svelte"
import { createLibraryCommands } from "./commands/libraryCommands"
import {
    configureLibraryUIController,
    configureLibraryUIStorage,
    LibraryUIController,
} from "./state/libraryUI.svelte"
import { configurePromptStorage } from "./commands/promptStore.svelte"
import type { Disposable, PromptService } from "$lib/extension-api"
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
    prompt: PromptService | undefined,
    onDispose?: () => void,
): Promise<void> {
    const libraryStorage = context.storage.namespace("library")
    await context.migration?.migrateLibrary(libraryStorage)
    const store = configureLibraryStore(libraryStorage)
    await store.init()
    configureLibraryUIStorage(libraryStorage)
    configurePromptStorage(libraryStorage)
    const unavailablePrompt: PromptService = {
        choose: async () => undefined,
        open: async () => undefined,
        close: () => undefined,
        setQuery: () => undefined,
        refresh: () => undefined,
        snapshot: null,
        isOpen: false,
        query: "",
    }
    const hostPrompt = context.host
        ? new Proxy(unavailablePrompt, {
              get: (_, key: keyof PromptService) => context.host?.prompt?.promptStore[key],
          })
        : unavailablePrompt
    configureLibraryHostBridge({
        prompt: prompt ?? hostPrompt,
        execute: (commandId, payload) => context.commands.execute(commandId, payload),
    })
    const notificationHandles = new Set<Disposable>()
    configureLibraryNotifications((message, level = "info") => {
        const handle = context.notifications[level](message)
        notificationHandles.add(handle)
        return handle
    })

    const libraryUI = new LibraryUIController()
    configureLibraryUIController(libraryUI)
    const commands = createLibraryCommands(libraryUI)
    const registrations = Object.values(commands).map((value) => {
        const command = value as AnyCommandDefinition
        const contribution = {
            id: command.id,
            label: command.label,
            // The dashboard scope owns the contextual recursive-open `o` binding. Keeping it
            // out of the host registry avoids a permanent conflict with library.book.open.
            keybinding: (() => {
                if (command.id === "library.book.open-recursive" || !command.keymap)
                    return undefined
                return Array.isArray(command.keymap) ? command.keymap : [command.keymap]
            })(),
            execute: (payload: unknown) => command.run(payload as never),
            isEnabled: () => !command.disabled?.(),
            ...(command.allowInInputs === undefined
                ? {}
                : { allowInInputs: command.allowInInputs }),
            ...(command.preventDefault === undefined
                ? {}
                : { preventDefault: command.preventDefault }),
            ...(command.shouldHandleKey === undefined
                ? {}
                : { shouldHandleKey: command.shouldHandleKey }),
            ...(command.keyboardPayload === undefined
                ? {}
                : { keyboardPayload: command.keyboardPayload }),
        } satisfies CommandContribution & HostCommandMetadata
        return context.commands.register(contribution)
    })
    context.lifecycle.onDispose(async () => {
        for (const registration of registrations) registration.dispose()
        for (const handle of notificationHandles) handle.dispose()
        notificationHandles.clear()
        configureLibraryUIController(undefined)
        configureLibraryHostBridge(undefined)
        configurePromptStorage(undefined)
        configureLibraryNotifications(undefined)
        context.host?.contextualStatus?.clear()
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
    context.views.registerNative({
        id: "library.status",
        slot: "host.status",
        title: "Library status",
        kind: "native",
        component: LibraryStatus,
    })
}
