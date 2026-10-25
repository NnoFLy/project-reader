// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest"
import { flushSync, mount, unmount } from "svelte"
import { COMMANDS_CONTEXT_KEY, commandsStore } from "$lib/core/commands"
import * as m from "$lib/paraglide/messages"
import { tooltip } from "$lib/shared/actions/tooltip"
import { getViewerRuntimeContext, type ViewerRuntime } from "../viewerRuntime"
import ViewerHeader from "./ViewerHeader.svelte"
import headerSource from "./ViewerHeader.svelte?raw"
import canvasSource from "./CanvasPane.svelte?raw"

vi.mock("$lib/shared/state/viewport.svelte", () => ({
    viewport: { isCompact: false, isPhoneLandscape: false },
}))
vi.mock("../viewerRuntime", () => ({ getViewerRuntimeContext: vi.fn() }))
vi.mock("$lib/shared/actions/tooltip", () => ({ tooltip: vi.fn() }))

describe("ViewerHeader document identity", () => {
    it.each([false, true])(
        "marks the global Settings launcher with shortcut metadata when loaded=%s",
        async (isLoaded) => {
            const executeCommand = vi.fn(async () => undefined)
            vi.mocked(getViewerRuntimeContext).mockReturnValue(
                () => ({ executeCommand }) as unknown as ViewerRuntime,
            )
            const target = document.createElement("div")
            document.body.append(target)
            const component = mount(ViewerHeader, {
                target,
                context: new Map([[COMMANDS_CONTEXT_KEY, commandsStore.root]]),
                props: { name: "Book", isLoaded },
            })
            try {
                flushSync()
                const launcher = target.querySelector<HTMLButtonElement>(
                    "header [data-settings-trigger]",
                )!
                expect(launcher).not.toBeNull()
                expect(target.querySelectorAll("[data-settings-trigger]")).toHaveLength(1)
                expect(launcher.getAttribute("aria-label")).toBe(m.settings())
                expect(launcher.getAttribute("aria-keyshortcuts")).toBe("Control+,")
                expect(
                    vi.mocked(tooltip).mock.calls.find(([node]) => node === launcher)?.[1],
                ).toMatchObject({
                    text: `${m.settings()} (Ctrl+,)`,
                })
                launcher.click()
                expect(executeCommand).toHaveBeenCalledExactlyOnceWith("settings.open")
            } finally {
                await unmount(component)
                target.remove()
            }
        },
    )

    it("does not assume a document format", () => {
        expect(headerSource).not.toContain("PDF")
        expect(headerSource).not.toContain(".pdf")
        expect(headerSource).not.toContain("file-badge")
        expect(headerSource).toContain("{name || m.unknown_book()}")
    })

    it("keeps the document name and close action accessible", () => {
        expect(headerSource).toContain('<h1 class="file-name" title={name}>')
        expect(headerSource).toContain("aria-label={m.close_document()}")
    })

    it("keeps the scrollable document keyboard reachable", () => {
        const frame = canvasSource.split('class="canvas-frame"')[1].split("bind:this")[0]
        expect(frame).toContain('role="region"')
        expect(frame).toContain('tabindex="0"')
        expect(frame).toContain("aria-label={m.viewer_reading_region()}")
    })
})
