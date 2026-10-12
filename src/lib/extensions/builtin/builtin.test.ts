import { describe, expect, it } from "vitest"
import { BUILTIN_MANIFESTS, createBuiltinHost } from "."

describe("built-in contributions", () => {
    it("activates native route contributions and disposes them with the host", async () => {
        const host = createBuiltinHost()

        await host.start()

        expect(host.contributions.listViews().map((view) => view.id)).toEqual([
            "library.page",
            "prompt.palette",
            "viewer.reader",
            "settings.panel",
        ])
        expect(host.contributions.listCommands()).toEqual([])
        expect(host.record("builtin.pdf")?.state).toBe("enabled")

        await host.dispose()

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
