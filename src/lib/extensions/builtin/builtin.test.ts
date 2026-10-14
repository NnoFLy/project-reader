import { describe, expect, it } from "vitest"
import { BUILTIN_MANIFESTS, createBuiltinHost } from "."

describe("built-in contributions", () => {
    it("activates native route contributions and disposes them with the host", async () => {
        const host = createBuiltinHost()

        await host.start()

        expect(host.contributions.listViews("host.status")).toEqual([
            expect.objectContaining({ id: "library.status", slot: "host.status" }),
            expect.objectContaining({ id: "viewer.status", slot: "host.status" }),
        ])
        expect(host.contributions.listViews()).toEqual([
            expect.objectContaining({
                id: "library.page",
                kind: "native",
                component: expect.anything(),
            }),
            expect.objectContaining({
                id: "library.status",
                kind: "native",
                component: expect.anything(),
            }),
            expect.objectContaining({
                id: "prompt.help",
                kind: "native",
                component: expect.anything(),
            }),
            expect.objectContaining({
                id: "prompt.palette",
                kind: "native",
                component: expect.anything(),
            }),
            expect.objectContaining({
                id: "settings.panel",
                kind: "native",
                component: expect.anything(),
            }),
            expect.objectContaining({
                id: "viewer.reader",
                kind: "native",
                component: expect.anything(),
            }),
            expect.objectContaining({
                id: "viewer.status",
                kind: "native",
                component: expect.anything(),
            }),
        ])
        expect(host.contributions.listCommands().map(({ id }) => id)).toEqual([
            "library.book.open",
            "library.book.open-recursive",
            "library.book.read-state.toggle",
            "library.folder.open",
            "library.folder.create",
            "library.node.rename",
            "library.continue-reading",
            "library.primary-action",
            "library.selection.toggle",
            "library.selection.all",
            "library.selection.clear",
            "library.selection.move",
            "library.selection.delete",
            "library.node.move",
            "library.node.pin.toggle",
            "library.node.delete",
            "library.node.edit-metadata",
            "library.node.relink",
            "prompt.open",
            "prompt.close",
            "prompt.help.toggle",
            "settings.theme",
            "settings.layout",
            "settings.language",
            "settings.zoom.in",
            "settings.zoom.out",
            "settings.quality.in",
            "settings.quality.out",
            "settings.animations.toggle",
            "settings.pdf-title.toggle",
            "viewer.open",
            "viewer.bookmark.open",
        ])
        expect(
            host.commands.listKeybindings().find(({ commandId }) => commandId === "viewer.open"),
        ).toMatchObject({ keybinding: "shift+o" })
        expect(host.record("builtin.pdf")?.state).toBe("enabled")
        host.contextualStatus.publish("test.status", {
            line1: "1",
            line2: "TEST",
            priority: 1,
        })
        expect(host.contextualStatus.current?.line1).toBe("1")

        await host.dispose()

        expect(host.contextualStatus.current).toBeNull()
        expect(host.contributions.listViews()).toEqual([])
        expect(host.record("builtin.library")?.state).toBe("disposed")
    })

    it("registers the PDF adapter only when its document activation event fires", async () => {
        const host = createBuiltinHost()

        await host.start()
        expect(host.contributions.listAdapters()).toEqual([])

        await host.activateForDocumentType("pdf")

        expect(host.contributions.listAdapters()).toEqual([
            expect.objectContaining({
                id: "builtin.pdf.document",
                extensionId: "builtin.pdf",
                extensions: ["pdf"],
                mimeTypes: ["application/pdf"],
            }),
        ])
        expect(host.documentService.adapters.get("builtin.pdf.document")).toBe(
            host.contributions.listAdapters()[0],
        )
        expect(BUILTIN_MANIFESTS.find(({ id }) => id === "builtin.pdf")?.activationEvents).toEqual([
            { type: "onDocumentType", extension: "pdf" },
        ])

        await host.dispose()

        expect(host.contributions.listAdapters()).toEqual([])
        expect(host.documentService.adapters.get("builtin.pdf.document")).toBeUndefined()
    })
})
