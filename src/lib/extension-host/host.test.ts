import { describe, expect, it, vi } from "vitest"
import type { AppExtension, DocumentAdapter, ExtensionContext } from "../extension-api"
import { DocumentService } from "../core/documents"
import { MemoryStorageBackend } from "../core/storage"
import { ExtensionHost } from "./host"

const extension = (id: string, activate: AppExtension["activate"]): AppExtension => ({
    manifest: {
        id,
        name: id,
        version: "1.0.0",
        engine: "*",
        entry: id,
        activationEvents: [{ type: "startup" }],
        permissions: ["commands"],
    },
    activate,
})

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

describe("extension host lifecycle", () => {
    it("derives and enforces manifest permissions on the real context", async () => {
        let context: ExtensionContext | undefined
        const restricted = {
            ...extension("builtin.restricted", (value) => {
                context = value
            }),
            manifest: {
                ...extension("builtin.restricted", () => undefined).manifest,
                permissions: [],
            },
        } satisfies AppExtension
        const host = new ExtensionHost({ extensions: [restricted] })

        await host.activate("builtin.restricted")

        const activated = context as ExtensionContext
        expect(activated.permissions?.list()).toEqual([])
        expect(() => activated.commands.list()).toThrow("permission: commands")
        expect(() => activated.views.list()).toThrow("permission: views")
        expect(() => activated.settings.list()).toThrow("permission: settings")
        expect(() => activated.documents.list()).toThrow("permission: documents")
        expect(() => activated.notifications.info("denied")).toThrow("permission: notifications")
        expect(() => activated.storage.get("denied")).toThrow("permission: storage")
    })

    it("wires settings to durable extension-scoped storage", async () => {
        const storage = new MemoryStorageBackend()
        const values: unknown[] = []
        let activations = 0
        const settingsExtension = {
            ...extension("builtin.settings", async (context) => {
                context.settings.register({
                    id: "settings.theme",
                    label: "Theme",
                    defaultValue: "system",
                })
                activations += 1
                if (activations === 1) await context.settings.setValue("settings.theme", "dark")
                else values.push(await context.settings.getValue("settings.theme"))
            }),
            manifest: {
                ...extension("builtin.settings", () => undefined).manifest,
                permissions: ["settings", "storage"],
            },
        } satisfies AppExtension
        const host = new ExtensionHost({ extensions: [settingsExtension], storage })

        await host.activate("builtin.settings")
        await host.disable("builtin.settings")
        await host.enable("builtin.settings")
        await host.activate("builtin.settings")

        expect(values).toEqual(["dark"])
    })

    it("registers document contributions in the core document service", async () => {
        const documentService = new DocumentService()
        const registeringExtension = {
            ...extension("builtin.viewer", ({ documents }) => {
                documents.register(adapter)
            }),
            manifest: {
                ...extension("builtin.viewer", () => undefined).manifest,
                permissions: ["commands", "documents"],
                contributes: { adapters: [adapter] },
            },
        } satisfies AppExtension
        const host = new ExtensionHost({ extensions: [registeringExtension], documentService })
        await host.activate("builtin.viewer")
        expect(documentService.adapters.get(adapter.id)).toMatchObject({ id: adapter.id })
        expect(host.contributions.listAdapters()).toHaveLength(1)
        await host.disable("builtin.viewer")
        expect(documentService.adapters.get(adapter.id)).toBeUndefined()
    })

    it("shares concurrent activation and isolates failures", async () => {
        let activations = 0
        const good = extension("runtime.good", async ({ commands }) => {
            activations += 1
            await Promise.resolve()
            commands.register({ id: "runtime.good.run", label: "Run", execute: () => "ok" })
        })
        const bad = extension("runtime.bad", ({ commands }) => {
            commands.register({
                id: "runtime.bad.partial",
                label: "Partial",
                execute: () => undefined,
            })
            throw new Error("boom")
        })
        const host = new ExtensionHost({ extensions: [good, bad] })
        await Promise.all([host.activate("runtime.good"), host.activate("runtime.good")])
        expect(activations).toBe(1)
        await expect(host.activate("runtime.bad")).rejects.toThrow("runtime.bad")
        expect(host.record("runtime.bad")?.state).toBe("failed")
        expect(host.contributions.listCommands()).toEqual([
            expect.objectContaining({ id: "runtime.good.run" }),
        ])
        await host.dispose()
        expect(host.record("runtime.good")?.state).toBe("disposed")
    })

    it("does not resurrect an extension when disable races activation", async () => {
        let release: (() => void) | undefined
        const started = new Promise<void>((resolve) => (release = resolve))
        const racingExtension = extension("builtin.viewer", async ({ commands }) => {
            await started
            commands.register({ id: "viewer.race", label: "Race", execute: () => undefined })
        })
        const host = new ExtensionHost({ extensions: [racingExtension] })
        const activation = host.activate("builtin.viewer")
        const disabling = host.disable("builtin.viewer")
        release?.()
        await expect(activation).resolves.toBeUndefined()
        await disabling
        expect(host.record("builtin.viewer")?.state).toBe("disabled")
        expect(host.contributions.listCommands()).toHaveLength(0)
    })

    it("shares concurrent disposal and rejects registration from disposed contexts", async () => {
        let register: (() => void) | undefined
        const disposableExtension = extension("builtin.viewer", ({ commands }) => {
            register = () => {
                commands.register({
                    id: "viewer.after-dispose",
                    label: "Disposed",
                    execute: () => undefined,
                })
            }
        })
        const host = new ExtensionHost({ extensions: [disposableExtension] })
        await host.activate("builtin.viewer")
        const first = host.dispose()
        expect(host.dispose()).toBe(first)
        await first
        expect(() => register?.()).toThrow("disposed")
    })

    it("closes documents through the document service during idempotent disposal", async () => {
        const documentService = new DocumentService()
        const events: string[] = []
        const closeAll = vi.spyOn(documentService, "closeAll").mockImplementation(async () => {
            events.push("documents")
        })
        const host = new ExtensionHost({
            extensions: [
                extension("builtin.viewer", ({ lifecycle }) => {
                    lifecycle.onDispose(() => {
                        events.push("extension")
                    })
                }),
            ],
            documentService,
        })
        await host.activate("builtin.viewer")

        const first = host.dispose()
        expect(host.dispose()).toBe(first)
        await first

        expect(closeAll).toHaveBeenCalledTimes(1)
        expect(events).toEqual(["documents", "extension"])
        expect(documentService.openDocumentCount).toBe(0)
    })

    it("rejects runtime extension short namespace collisions", () => {
        expect(
            () =>
                new ExtensionHost({
                    extensions: [
                        extension("builtin.viewer", () => undefined),
                        extension("runtime.viewer", () => undefined),
                    ],
                }),
        ).toThrow("Extension namespace is already registered")
    })

    it("rejects duplicate manifest keybindings and unknown permissions", () => {
        const manifest = {
            ...extension("builtin.viewer", () => undefined).manifest,
            permissions: ["future"] as never,
            contributes: {
                keybindings: [
                    { commandId: "viewer.open", keybinding: ["Ctrl+O"] },
                    { commandId: "viewer.close", keybinding: ["ctrl+o"] },
                ],
            },
        }
        expect(
            () => new ExtensionHost({ extensions: [{ manifest, activate: () => undefined }] }),
        ).toThrow("Unsupported permission")
        expect(
            () =>
                new ExtensionHost({
                    extensions: [
                        {
                            manifest: {
                                ...manifest,
                                permissions: [],
                            },
                            activate: () => undefined,
                        },
                    ],
                }),
        ).toThrow("Keybinding is already declared")
    })
})
