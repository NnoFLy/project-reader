import { describe, expect, it, vi } from "vitest"
import type { AppExtension, CommandRegistry, ExtensionManifest } from "$lib/extension-api"
import { ExtensionHost } from "$lib/extension-host"

function manifest(id: string): ExtensionManifest {
    return {
        id,
        name: id,
        version: "0.0.1",
        engine: ">=0.0.1",
        entry: id,
        activationEvents: [{ type: "startup" }],
        permissions: ["commands"],
    }
}

describe("host command contributions", () => {
    it("exposes and executes exactly one viewer.open command", async () => {
        const open = vi.fn()
        let viewerCommands: CommandRegistry | undefined
        const viewerExtension: AppExtension = {
            manifest: manifest("builtin.viewer"),
            activate: ({ commands }) => {
                viewerCommands = commands
                commands.register({
                    id: "viewer.open",
                    label: "Open viewer",
                    execute: open,
                })
            },
        }
        const libraryExtension: AppExtension = {
            manifest: manifest("builtin.library"),
            activate: ({ commands }) => {
                commands.register({
                    id: "library.primary-action",
                    label: "Open library item",
                    execute: (payload) => {
                        if (!viewerCommands) throw new Error("Viewer commands are unavailable")
                        return viewerCommands.execute("viewer.open", payload)
                    },
                })
            },
        }
        const host = new ExtensionHost({ extensions: [viewerExtension, libraryExtension] })

        await host.start()

        const viewerOpenCommands = host.contributions
            .listCommands()
            .filter(({ id }) => id === "viewer.open")
        expect(viewerOpenCommands).toHaveLength(1)

        const libraryAction = host.contributions
            .listCommands()
            .find(({ id }) => id === "library.primary-action")
        await libraryAction?.execute({ bookId: "book-1" })

        expect(open).toHaveBeenCalledOnce()
        expect(open).toHaveBeenCalledWith({ bookId: "book-1" })

        await host.dispose()
    })
})
