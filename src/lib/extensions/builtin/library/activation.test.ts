// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest"

vi.hoisted(() => {
    window.matchMedia = (() =>
        ({
            matches: false,
            addEventListener: () => undefined,
            removeEventListener: () => undefined,
        }) as unknown as MediaQueryList) as typeof window.matchMedia
})

import type { ExtensionContext } from "$lib/extension-api"
import { createExtensionStorage, MemoryStorageBackend } from "$lib/core/storage"
import { activateLibrary, libraryStore } from "."

function createLibraryContext(): ExtensionContext {
    return {
        extension: {
            id: "builtin.library",
            name: "Library",
            version: "0.0.1",
            engine: ">=0.0.1",
        },
        commands: {
            register: () => ({ dispose() {} }),
        } as unknown as ExtensionContext["commands"],
        views: {
            registerNative: () => ({ dispose() {} }),
        } as unknown as ExtensionContext["views"],
        settings: {} as ExtensionContext["settings"],
        documents: {} as ExtensionContext["documents"],
        storage: createExtensionStorage(new MemoryStorageBackend(), "builtin.library"),
        notifications: {
            info: () => ({ dispose() {} }),
            warning: () => ({ dispose() {} }),
            error: () => ({ dispose() {} }),
        } as unknown as ExtensionContext["notifications"],
        lifecycle: {
            state: "active",
            onDispose: () => ({ dispose() {} }),
            isDisposed: () => false,
        },
        get host() {
            return undefined
        },
    }
}

describe("library host activation", () => {
    it("initializes persisted state before a direct viewer route can use it", async () => {
        const context = createLibraryContext()
        const register = vi.spyOn(context.commands, "register")
        await activateLibrary(context, undefined)

        expect(libraryStore.initialized).toBe(true)
        expect(register).toHaveBeenCalled()
        for (const [command] of register.mock.calls) {
            expect(typeof command.englishLabel, command.id).toBe("function")
            const englishLabel = command.englishLabel as () => string
            expect(englishLabel().trim(), command.id).toBeTruthy()
        }
    })
})
