import { describe, expect, it } from "vitest"
import type { AppExtension } from "../extension-api"
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

describe("extension host lifecycle", () => {
    it("shares concurrent activation and isolates failures", async () => {
        let activations = 0
        const good = extension("builtin.good", async ({ commands }) => {
            activations += 1
            await Promise.resolve()
            commands.register({ id: "good.run", label: "Run", execute: () => "ok" })
        })
        const bad = extension("builtin.bad", ({ commands }) => {
            commands.register({ id: "bad.partial", label: "Partial", execute: () => undefined })
            throw new Error("boom")
        })
        const host = new ExtensionHost({ extensions: [good, bad] })
        await Promise.all([host.activate("builtin.good"), host.activate("builtin.good")])
        expect(activations).toBe(1)
        await expect(host.activate("builtin.bad")).rejects.toThrow("builtin.bad")
        expect(host.record("builtin.bad")?.state).toBe("failed")
        expect(host.contributions.listCommands()).toEqual([
            expect.objectContaining({ id: "good.run" }),
        ])
        await host.dispose()
        expect(host.record("builtin.good")?.state).toBe("disposed")
    })
})
