import { describe, expect, it, vi } from "vitest"
import type { DocumentAdapter } from "../extension-api"
import { createPermissionSet } from "../extension-api"
import { MemoryStorageBackend, createExtensionStorage } from "../core/storage"
import type { HostCommandMetadata } from "../core/commands"
import { ContributionRegistry } from "./contribution-registry"

const adapter: DocumentAdapter = {
    id: "viewer.test-adapter",
    extensions: ["test"],
    mimeTypes: ["application/test"],
    probe: async () => ({ supported: true }),
    open: async () => ({
        kind: "reflowable",
        metadata: { title: null, author: null },
        capabilities: new Set(),
        close: async () => undefined,
        getSections: async () => [],
    }),
}

describe("contribution registries", () => {
    it("validates namespaces, duplicate IDs, and disposal", () => {
        const registry = new ContributionRegistry().forExtension(
            "builtin.viewer",
            createPermissionSet(["commands"]),
        )
        const disposable = registry.commands.register({
            id: "viewer.next-page",
            label: "Next page",
            execute: () => undefined,
        })
        expect(() =>
            registry.commands.register({
                id: "viewer.next-page",
                label: "Duplicate",
                execute: () => undefined,
            }),
        ).toThrow("already registered")
        expect(() =>
            registry.commands.register({
                id: "library.open",
                label: "Open",
                execute: () => undefined,
            }),
        ).toThrow("outside extension namespace")
        disposable.dispose()
        expect(registry.commands.list()).toHaveLength(0)
        registry.dispose()
        expect(() =>
            registry.commands.register({
                id: "viewer.next-page",
                label: "Disposed",
                execute: () => undefined,
            }),
        ).toThrow("disposed")
    })

    it("denies registries without their declared permissions", () => {
        const registries = new ContributionRegistry().forExtension(
            "builtin.viewer",
            createPermissionSet([]),
        )

        expect(() =>
            registries.commands.register({
                id: "viewer.run",
                label: "Run",
                execute: () => undefined,
            }),
        ).toThrow("permission: commands")
        expect(() => registries.views.list()).toThrow("permission: views")
        expect(() => registries.documents.list()).toThrow("permission: documents")
        expect(() => registries.settings.list()).toThrow("permission: settings")
        expect("listForHost" in registries.views).toBe(false)
        expect("listForHost" in registries.documents).toBe(false)
    })

    it("discovers and executes prompt commands through the host registry", async () => {
        const contributions = new ContributionRegistry()
        const viewer = contributions.forExtension(
            "builtin.viewer",
            createPermissionSet(["commands"]),
        )
        const prompt = contributions.forExtension(
            "builtin.prompt",
            createPermissionSet(["commands"]),
        )
        const execute = vi.fn(() => "ok")
        viewer.commands.register({
            id: "viewer.run",
            label: "Run",
            validatePayload: (payload) => payload === "valid",
            isEnabled: (context) => context === "enabled",
            execute,
        })
        prompt.commands.register({
            id: "prompt.open",
            label: "Open",
            execute: () => undefined,
        })

        expect(prompt.commands.list().map(({ id }) => id)).toEqual(["viewer.run", "prompt.open"])
        await expect(prompt.commands.execute("viewer.run", "valid", "enabled")).resolves.toBe("ok")
        await expect(prompt.commands.execute("viewer.run", "invalid", "enabled")).rejects.toThrow(
            "Invalid payload",
        )
        await expect(
            prompt.commands.execute("viewer.run", "valid", "disabled"),
        ).resolves.toBeUndefined()
        const library = contributions.forExtension(
            "builtin.library",
            createPermissionSet(["commands"]),
        )
        await expect(library.commands.execute("viewer.run", "valid", "enabled")).resolves.toBe("ok")
        expect(execute).toHaveBeenCalledTimes(2)
        expect(viewer.commands.list().map(({ id }) => id)).toEqual(["viewer.run"])
    })

    it("discovers command keybindings through the shared host facade", () => {
        const contributions = new ContributionRegistry()
        const viewer = contributions.forExtension(
            "builtin.viewer",
            createPermissionSet(["commands"]),
        )
        viewer.commands.register({
            id: "viewer.open",
            label: "Open",
            keybinding: ["ctrl+o", "meta+o"],
            execute: () => undefined,
        })
        expect(contributions.globalCommands.listKeybindings()).toEqual([
            { commandId: "viewer.open", keybinding: "ctrl+o", extensionId: "builtin.viewer" },
            { commandId: "viewer.open", keybinding: "meta+o", extensionId: "builtin.viewer" },
        ])
    })

    it("keeps command keyboard metadata on host bindings", () => {
        const contributions = new ContributionRegistry()
        const viewer = contributions.forExtension(
            "builtin.viewer",
            createPermissionSet(["commands"]),
        )
        const shouldHandleKey = vi.fn(() => true)
        const keyboardPayload = vi.fn(() => ({ repeated: false }))
        viewer.commands.register({
            id: "viewer.open",
            label: "Open",
            keybinding: ["ctrl+o"],
            execute: () => undefined,
            isEnabled: () => true,
            ...({
                allowInInputs: true,
                preventDefault: false,
                shouldHandleKey,
                keyboardPayload,
            } satisfies HostCommandMetadata),
        })

        expect(contributions.globalCommands.listKeybindings()).toEqual([
            {
                commandId: "viewer.open",
                keybinding: "ctrl+o",
                extensionId: "builtin.viewer",
                allowInInputs: true,
                preventDefault: false,
                shouldHandleKey,
                keyboardPayload,
                isEnabled: expect.any(Function),
            },
        ])
    })

    it("allows each declared registry capability", () => {
        const registries = new ContributionRegistry().forExtension(
            "builtin.viewer",
            createPermissionSet(["commands", "documents", "settings", "views"]),
        )

        registries.commands.register({
            id: "viewer.run",
            label: "Run",
            execute: () => undefined,
        })
        registries.views.register({ id: "viewer.panel", slot: "viewer.toolbar" })
        registries.documents.register(adapter)
        registries.settings.register({ id: "viewer.theme", label: "Theme", defaultValue: "dark" })

        expect(registries.commands.list()).toHaveLength(1)
        expect(registries.views.list()).toHaveLength(1)
        expect(registries.documents.list()).toHaveLength(1)
        expect(registries.settings.list()).toHaveLength(1)
    })

    it("rejects nested command shadowing", () => {
        const registries = new ContributionRegistry().forExtension(
            "builtin.viewer",
            createPermissionSet(["commands"]),
        )

        registries.commands.register({
            id: "viewer.menu",
            label: "Menu",
            execute: () => undefined,
        })
        expect(() =>
            registries.commands.register({
                id: "viewer.menu.open",
                label: "Open",
                execute: () => undefined,
            }),
        ).toThrow("shadows")
        expect(() =>
            registries.commands.register({
                id: "builtin.viewer.menu",
                label: "Alias",
                execute: () => undefined,
            }),
        ).toThrow("shadows")
    })

    it("uses the extension-scoped durable store for settings", async () => {
        const storage = createExtensionStorage(new MemoryStorageBackend(), "builtin.viewer")
        const permissions = createPermissionSet(["settings", "storage"])
        const first = new ContributionRegistry().forExtension(
            "builtin.viewer",
            permissions,
            storage,
        )
        first.settings.register({ id: "viewer.zoom", label: "Zoom", defaultValue: 1 })
        await first.settings.setValue("viewer.zoom", 2)

        const reloaded = new ContributionRegistry().forExtension(
            "builtin.viewer",
            permissions,
            storage,
        )
        reloaded.settings.register({ id: "viewer.zoom", label: "Zoom", defaultValue: 1 })
        await expect(reloaded.settings.getValue<number>("viewer.zoom")).resolves.toBe(2)
    })
})
