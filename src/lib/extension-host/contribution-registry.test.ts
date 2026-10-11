import { describe, expect, it } from "vitest"
import { ContributionRegistry } from "./contribution-registry"

describe("contribution registries", () => {
    it("validates namespaces, duplicate IDs, and disposal", () => {
        const registry = new ContributionRegistry().forExtension("builtin.viewer")
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
})
