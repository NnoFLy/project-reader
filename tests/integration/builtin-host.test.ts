import { describe, expect, it } from "vitest"
import type { AppExtension, ExtensionStorage } from "$lib/extension-api"
import { ExtensionHost } from "$lib/extension-host"
import { BUILTIN_MANIFESTS, createBuiltinHost } from "$lib/extensions/builtin"
import { MemoryStorageBackend } from "$lib/core/storage"

const integrationExtension = (id: string, activate: AppExtension["activate"]): AppExtension => ({
    manifest: {
        id,
        name: id,
        version: "1.0.0",
        engine: "*",
        entry: id,
        activationEvents: [{ type: "startup" }],
        permissions: ["commands", "documents", "settings", "storage", "views"],
    },
    activate,
})

describe("built-in extension host integration", () => {
    it("activates built-in startup extensions and lazy document extensions", async () => {
        const host = createBuiltinHost()

        await host.start()
        expect(host.records).toEqual(
            expect.arrayContaining(
                BUILTIN_MANIFESTS.map((manifest) =>
                    expect.objectContaining({
                        manifest,
                        state: manifest.id === "builtin.pdf" ? "enabled" : "active",
                    }),
                ),
            ),
        )

        await host.activateForDocumentType("pdf")
        expect(host.record("builtin.pdf")?.state).toBe("active")

        await host.dispose()
        expect(host.records.every((record) => record.state === "disposed")).toBe(true)
    })

    it("connects lifecycle, contribution registries, and namespaced storage", async () => {
        let firstStorage: ExtensionStorage | undefined
        let secondStorage: ExtensionStorage | undefined
        let disposed = false
        const first = integrationExtension("builtin.first", async (context) => {
            firstStorage = context.storage
            context.commands.register({
                id: "first.run",
                label: "Run",
                execute: () => "ok",
            })
            context.views.register({ id: "first.panel", slot: "workbench.panel" })
            context.settings.register({ id: "first.enabled", label: "Enabled", defaultValue: true })
            context.documents.register({
                id: "first.fake",
                extensions: ["fake"],
                open: async () => ({ id: "first-document", kind: "paged" }),
            })
            await context.storage.namespace("state").set("value", "first")
            context.lifecycle.onDispose(() => {
                disposed = true
            })
        })
        const second = integrationExtension("builtin.second", async (context) => {
            secondStorage = context.storage
            await context.storage.namespace("state").set("value", "second")
        })
        const host = new ExtensionHost({
            extensions: [first, second],
            storage: new MemoryStorageBackend(),
        })

        await host.start()
        expect(host.contributions.listCommands()).toEqual([
            expect.objectContaining({ id: "first.run", extensionId: "builtin.first" }),
        ])
        expect(host.contributions.listViews()).toEqual([
            expect.objectContaining({ id: "first.panel", extensionId: "builtin.first" }),
        ])
        expect(host.contributions.listAdapters()).toEqual([
            expect.objectContaining({ id: "first.fake", extensionId: "builtin.first" }),
        ])
        expect(firstStorage).toBeDefined()
        expect(secondStorage).toBeDefined()
        await expect(firstStorage!.namespace("state").get("value")).resolves.toBe("first")
        await expect(secondStorage!.namespace("state").get("value")).resolves.toBe("second")
        await expect(firstStorage!.get("value")).resolves.toBeUndefined()

        await host.dispose()
        expect(disposed).toBe(true)
        expect(host.contributions.listCommands()).toEqual([])
        expect(host.contributions.listAdapters()).toEqual([])
    })
})
