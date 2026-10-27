import { describe, expect, it } from "vitest"
import { createPermissionSet, type AppExtension, type ExtensionContext } from "../extension-api"
import { ContributionRegistry } from "./contribution-registry"
import { ExtensionHost } from "./host"
import { MemoryStorageBackend } from "../core/storage"
import { SettingsRegistryImpl } from "../core/settings"

function deferred<T>() {
    let resolve!: (value: T) => void
    let reject!: (error: Error) => void
    const promise = new Promise<T>((yes, no) => {
        resolve = yes
        reject = no
    })
    return { promise, resolve, reject }
}

const permissions = createPermissionSet(["settings", "commands"])

describe("host settings contract", () => {
    it("defaults generic registries to Plugins while only trusted composition assigns the exact common preferences", () => {
        const generic = new SettingsRegistryImpl("builtin.settings")
        generic.register({
            id: "settings.language",
            label: "Language",
            defaultValue: "ru",
            category: "general",
        })
        expect(generic.get("settings.language")?.category).toBe("plugins")
        const contributions = new ContributionRegistry()
        const builtin = contributions.forExtension("builtin.settings", permissions)
        for (const [id, category] of [
            ["settings.language", "general"],
            ["settings.theme", "appearance"],
            ["settings.ui-font", "appearance"],
            ["settings.ui-custom-font", "appearance"],
            ["settings.ui-font-size", "appearance"],
            ["settings.animations", "appearance"],
            ["settings.layout", "reading"],
            ["settings.scale", "reading"],
            ["settings.quality", "reading"],
            ["settings.prefer-pdf-title", "library"],
            ["settings.extra", "plugins"],
        ] as const) {
            builtin.settings.register({ id, label: id, defaultValue: 1, category: "library" })
            expect(contributions.globalSettings.get(id)?.category).toBe(category)
        }
        const plugin = contributions.forExtension("community.reader", permissions)
        plugin.settings.register({
            id: "community.reader.theme",
            label: "Theme",
            defaultValue: "dark",
            category: "appearance",
        })
        expect(contributions.globalSettings.get("community.reader.theme")?.category).toBe("plugins")
        expect(() =>
            plugin.settings.register({
                id: "settings.language",
                label: "Spoof",
                defaultValue: "ru",
                category: "general",
            }),
        ).toThrow("outside extension namespace")
        contributions.dispose()
        generic.dispose()
    })

    it("enforces scoped permissions, ownership and validators without trusting malformed editors", async () => {
        const contributions = new ContributionRegistry()
        const denied = contributions.forExtension("community.denied")
        expect(() => denied.settings.onDidChange(() => undefined)).toThrow("permission: settings")
        expect(() => denied.settings.resetValue("community.reader.size")).toThrow(
            "permission: settings",
        )
        const owner = contributions.forExtension("community.reader", permissions)
        expect(() =>
            owner.settings.register({ id: "community.other.size", label: "Size", defaultValue: 1 }),
        ).toThrow("outside extension namespace")
        owner.settings.register({
            id: "community.reader.size",
            label: "Size",
            defaultValue: 2,
            editor: { kind: "number", min: 0, max: 10 },
            validate: (value): value is number => typeof value === "number" && value % 2 === 0,
        })
        expect(() =>
            owner.settings.register({
                id: "community.reader.size",
                label: "Duplicate",
                defaultValue: 2,
            }),
        ).toThrow("already registered")
        await expect(
            contributions.globalSettings.setValue("community.reader.size", 3),
        ).rejects.toThrow("Invalid value")
        await expect(owner.settings.setValue("community.reader.size", -2)).rejects.toThrow(
            "Invalid value",
        )
        owner.settings.register({
            id: "community.reader.bad",
            label: "Bad",
            defaultValue: 1,
            editor: { kind: "number", min: 10, max: 1 },
        } as never)
        await expect(owner.settings.setValue("community.reader.bad", 5)).rejects.toThrow("editor")
        owner.settings.register({
            id: "community.reader.throwing",
            label: "Throwing",
            defaultValue: 1,
            editor: { kind: "number" },
            validate: (_value: unknown): _value is number => {
                throw new Error("private validator diagnostic")
            },
        })
        await expect(
            contributions.globalSettings.setValue("community.reader.throwing", 2),
        ).rejects.toThrow("Invalid")
        expect("globalSettings" in owner.settings).toBe(false)
    })

    it("exposes only active owners and retains durable values through disable and reactivation", async () => {
        const activated = deferred<void>()
        const finish = deferred<void>()
        const definition = {
            id: "community.reader.enabled",
            label: "Enabled",
            defaultValue: true,
            editor: { kind: "boolean" },
        } as const
        let context: ExtensionContext | undefined
        const abortCatalogs: string[][] = []
        let first = true
        const extension: AppExtension = {
            manifest: {
                id: "community.reader",
                name: "Reader tools",
                version: "1",
                engine: "*",
                entry: "test",
                activationEvents: [],
                permissions: ["settings", "storage"],
            },
            activate: async (value) => {
                context = value
                value.lifecycle.signal?.addEventListener("abort", () =>
                    abortCatalogs.push(host.settings.list().map((setting) => setting.id)),
                )
                value.settings.register(definition)
                if (first) {
                    first = false
                    activated.resolve()
                    await finish.promise
                }
            },
        }
        const failed: AppExtension = {
            ...extension,
            manifest: { ...extension.manifest, id: "community.failed", name: "Failed" },
            activate: (value) => {
                value.settings.register({ ...definition, id: "community.failed.enabled" })
                throw new Error("Activation failed")
            },
        }
        const host = new ExtensionHost({
            extensions: [extension, failed],
            storage: new MemoryStorageBackend(),
        })
        const catalogs: string[][] = []
        host.settings.onDidChange(() =>
            catalogs.push(host.settings.list().map((setting) => setting.id)),
        )
        expect(host.settings.list()).toEqual([])
        const activating = host.activate(extension.manifest.id)
        await activated.promise
        expect(host.settings.list()).toEqual([])
        expect(context?.host).not.toHaveProperty("globalSettings")
        expect(context?.host?.settings).toBeUndefined()
        finish.resolve()
        await activating
        const entry = host.settings.get(definition.id)!
        expect(entry.extensionName).toBe("Reader tools")
        await host.settings.setValue(definition.id, false, entry)
        await host.disable(extension.manifest.id)
        expect(abortCatalogs).toEqual([[]])
        expect(host.settings.list()).toEqual([])
        await expect(host.settings.setValue(definition.id, true, entry)).rejects.toThrow()
        await host.enable(extension.manifest.id)
        await host.activate(extension.manifest.id)
        await expect(
            host.settings.getValue(definition.id, host.settings.get(definition.id)),
        ).resolves.toBe(false)
        await expect(host.activate(failed.manifest.id)).rejects.toThrow()
        expect(host.settings.list().map((setting) => setting.id)).toEqual([definition.id])
        expect(catalogs).toContainEqual([])
        expect(catalogs).toContainEqual([definition.id])
        expect(catalogs.every((ids) => !ids.includes("community.failed.enabled"))).toBe(true)
        await host.dispose()
        expect(host.settings.list()).toEqual([])
    })

    it("fences captured settings and queued writes across same-id replacement", async () => {
        const contributions = new ContributionRegistry()
        const started = deferred<void>()
        const finish = deferred<void>()
        let saved = 1
        const store = {
            get: async <T>() => saved as T,
            set: async (_id: string, value: unknown) => {
                if (value === 2) {
                    started.resolve()
                    await finish.promise
                }
                saved = value as number
            },
        }
        const definition = {
            id: "community.reader.size",
            label: "Size",
            defaultValue: 1,
            editor: { kind: "number" },
        } as const
        const owner = contributions.forExtension("community.reader", permissions, store)
        owner.settings.register(definition)
        const captured = contributions.globalSettings.get(definition.id)!
        const events: unknown[] = []
        contributions.globalSettings.onDidChange((event) => events.push(event))
        const first = contributions.globalSettings.setValue(definition.id, 2, captured)
        await started.promise
        const queued = contributions.globalSettings.setValue(definition.id, 3, captured)
        const obsolete = Promise.allSettled([first, queued])
        owner.dispose()
        const replacement = contributions.forExtension("community.reader", permissions, store)
        replacement.settings.register(definition)
        const current = contributions.globalSettings.get(definition.id)!
        expect(current).not.toBe(captured)
        await expect(
            contributions.globalSettings.getValue(definition.id, captured),
        ).rejects.toThrow("no longer")
        await expect(
            contributions.globalSettings.setValue(definition.id, 9, captured),
        ).rejects.toThrow("no longer")
        await expect(
            contributions.globalSettings.resetValue(definition.id, captured),
        ).rejects.toThrow("no longer")
        const read = contributions.globalSettings.getValue(definition.id, current)
        const latest = contributions.globalSettings.setValue(definition.id, 4, current)
        finish.resolve()
        expect((await obsolete).map((result) => result.status)).toEqual(["rejected", "rejected"])
        await expect(read).resolves.toBe(2)
        await latest
        owner.dispose()
        expect(contributions.globalSettings.get(definition.id)).toBe(current)
        await expect(replacement.settings.getValue(definition.id)).resolves.toBe(4)
        expect(events.filter((event) => (event as { kind: string }).kind === "value")).toEqual([
            { kind: "value", settingId: definition.id, value: 4 },
        ])
    })

    it("publishes only durable writes and surfaces read and save failures", async () => {
        const pending = deferred<void>()
        const started = deferred<void>()
        let saved = 1
        let failRead = false
        const contributions = new ContributionRegistry()
        const owner = contributions.forExtension("community.reader", permissions, {
            get: async <T>() => {
                if (failRead) throw new Error("Read unavailable")
                return saved as T
            },
            set: async (_id, value) => {
                started.resolve()
                await pending.promise
                saved = value as number
            },
        })
        owner.settings.register({
            id: "community.reader.size",
            label: "Size",
            defaultValue: 1,
            editor: { kind: "number" },
        })
        const events: unknown[] = []
        owner.settings.onDidChange((event) => events.push(event))
        const write = contributions.globalSettings.setValue("community.reader.size", 2)
        await started.promise
        expect(events).toEqual([])
        const read = contributions.globalSettings.getValue("community.reader.size")
        let readFinished = false
        void read.then(() => {
            readFinished = true
        })
        await Promise.resolve()
        await Promise.resolve()
        expect(readFinished).toBe(false)
        pending.reject(new Error("Save unavailable"))
        await expect(write).rejects.toThrow("Save unavailable")
        await expect(read).resolves.toBe(1)
        expect(events).toEqual([])
        failRead = true
        await expect(owner.settings.getValue("community.reader.size")).rejects.toThrow(
            "Read unavailable",
        )
    })

    it("validates generated editors without guessing legacy or malformed metadata", async () => {
        const contributions = new ContributionRegistry()
        const owner = contributions.forExtension("community.reader", permissions)
        const cases = [
            {
                name: "enabled",
                defaultValue: true,
                editor: { kind: "boolean" },
                valid: false,
                invalid: "false",
            },
            {
                name: "mode",
                defaultValue: "a",
                editor: {
                    kind: "choice",
                    choices: [
                        { value: "a", label: () => "A" },
                        { value: "b", label: "<b>B</b>" },
                    ],
                },
                valid: "b",
                invalid: "c",
            },
            {
                name: "title",
                defaultValue: "ok",
                editor: { kind: "text", minLength: 1, maxLength: 4 },
                valid: "new",
                invalid: "long title",
            },
            {
                name: "size",
                defaultValue: 2,
                editor: { kind: "number", min: 0, max: 4, step: 2 },
                valid: 4,
                invalid: 3,
            },
        ] as const
        for (const entry of cases) {
            const id = `community.reader.${entry.name}`
            owner.settings.register({
                id,
                label: () => entry.name,
                description: "<script>not markup</script>",
                defaultValue: entry.defaultValue,
                editor: entry.editor,
                category: "appearance",
            })
            expect(contributions.globalSettings.get(id)).toMatchObject({
                category: "plugins",
                editor: expect.objectContaining({ kind: entry.editor.kind }),
            })
            await contributions.globalSettings.setValue(id, entry.valid)
            await expect(contributions.globalSettings.setValue(id, entry.invalid)).rejects.toThrow(
                "Invalid value",
            )
            await contributions.globalSettings.resetValue(id)
            await expect(owner.settings.getValue(id)).resolves.toBe(entry.defaultValue)
        }
        const malformed = [
            undefined,
            { kind: "object" },
            { kind: "number", min: 4, max: 1 },
            { kind: "choice", choices: [] },
            {
                kind: "choice",
                choices: [
                    { value: "x", label: "X" },
                    { value: "x", label: "Duplicate" },
                ],
            },
        ]
        for (const [index, editor] of malformed.entries()) {
            const id = `community.reader.bad${index}`
            owner.settings.register({ id, label: "Bad", defaultValue: "x", editor } as never)
            expect(contributions.globalSettings.get(id)?.editorUnavailableReason).toEqual(
                expect.any(String),
            )
            await expect(contributions.globalSettings.setValue(id, "x")).rejects.toThrow("editor")
        }
        const builtin = contributions.forExtension("builtin.settings", permissions)
        builtin.settings.register({
            id: "settings.theme",
            label: "Theme",
            defaultValue: true,
            editor: { kind: "boolean" },
            category: "appearance",
        })
        builtin.settings.register({
            id: "settings.extra",
            label: "Extra",
            defaultValue: true,
            editor: { kind: "boolean" },
            category: "appearance",
        })
        expect(contributions.globalSettings.get("settings.theme")?.category).toBe("appearance")
        expect(contributions.globalSettings.get("settings.extra")?.category).toBe("plugins")
    })

    it("discovers legacy declarations and routes scoped command writes and reset", async () => {
        const contributions = new ContributionRegistry()
        const owner = contributions.forExtension("community.reader", permissions)
        const stranger = contributions.forExtension("community.other", permissions)
        const events: unknown[] = []
        const subscription = contributions.globalSettings.onDidChange((event) => events.push(event))
        const registration = owner.settings.register({
            id: "community.reader.enabled",
            label: "Enabled",
            defaultValue: true,
        })
        expect(contributions.globalSettings.list()).toEqual([
            expect.objectContaining({
                id: "community.reader.enabled",
                extensionId: "community.reader",
            }),
        ])
        expect(stranger.settings.list()).toEqual([])
        await expect(stranger.settings.setValue("community.reader.enabled", false)).rejects.toThrow(
            "not registered",
        )
        owner.commands.register({
            id: "community.reader.toggle",
            label: "Toggle",
            execute: () => owner.settings.setValue("community.reader.enabled", false),
        })
        await contributions.globalCommands.execute("community.reader.toggle")
        await expect(
            contributions.globalSettings.getValue("community.reader.enabled"),
        ).resolves.toBe(false)
        await owner.settings.resetValue("community.reader.enabled")
        await expect(owner.settings.getValue("community.reader.enabled")).resolves.toBe(true)
        registration.dispose()
        expect(events).toEqual([
            { kind: "catalog" },
            { kind: "value", settingId: "community.reader.enabled", value: false },
            { kind: "value", settingId: "community.reader.enabled", value: true },
            { kind: "catalog" },
        ])
        subscription.dispose()
    })
})
