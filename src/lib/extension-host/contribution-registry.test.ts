import { describe, expect, it } from "vitest"
import type { DocumentAdapter } from "../extension-api"
import { createPermissionSet } from "../extension-api"
import { MemoryStorageBackend, createExtensionStorage } from "../core/storage"
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
