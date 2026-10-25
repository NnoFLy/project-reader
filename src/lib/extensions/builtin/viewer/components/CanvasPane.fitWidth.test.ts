// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { flushSync, mount, unmount } from "svelte"
import { fromStore, writable } from "svelte/store"
import { commandsStore } from "$lib/core/commands"
import { getViewerRuntimeContext, type ViewerRuntime } from "../viewerRuntime"
import type { ViewerPagedDocument } from "../viewerDocument"
import CanvasPane from "./CanvasPane.svelte"

vi.mock("$lib/shared/state/viewport.svelte", () => ({
    viewport: { isCompact: true, isShortHeight: false, innerWidth: 390, innerHeight: 844 },
}))
vi.mock("../viewerRuntime", () => ({ getViewerRuntimeContext: vi.fn() }))

let component: ReturnType<typeof mount> | undefined
const originalScrollTo = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollTo")

beforeEach(() => {
    vi.stubGlobal(
        "ResizeObserver",
        class {
            observe() {}
            unobserve() {}
            disconnect() {}
        },
    )
    vi.stubGlobal("matchMedia", () => ({
        matches: false,
        addEventListener() {},
        removeEventListener() {},
    }))
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(390)
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(844)
    HTMLElement.prototype.scrollTo = vi.fn()
})

afterEach(async () => {
    if (component) await unmount(component)
    component = undefined
    document.body.replaceChildren()
    if (originalScrollTo) Object.defineProperty(HTMLElement.prototype, "scrollTo", originalScrollTo)
    else Reflect.deleteProperty(HTMLElement.prototype, "scrollTo")
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
})

it("fits compact portrait width by resetting 75% zoom to the 150% baseline", async () => {
    const zoom = writable(0.75)
    const scale = fromStore(zoom)
    const store = {
        get scale() {
            return scale.current
        },
        set scale(value: number) {
            zoom.set(value)
        },
    }
    const runtime = {
        store,
        settings: {
            DEFAULT_SETTINGS: { scale: 1.5 },
            settingsStore: { animations: false },
        },
        notes: { notes: [] },
        search: { matches: [], isActive: false },
    } as unknown as ViewerRuntime
    vi.mocked(getViewerRuntimeContext).mockReturnValue(() => runtime)
    const pdf = {
        pageCount: 1,
        getPage: async () => ({ pageNumber: 1, width: 600, height: 900 }),
    } as unknown as ViewerPagedDocument
    component = mount(CanvasPane, {
        target: document.body,
        props: {
            pdf,
            currentPage: 1,
            scrollPosition: 0,
            currentPageImage: "data:image/png;base64,",
            currentPageDim1: { width: 600, height: 900 },
            renderLayers: false,
            get scale() {
                return store.scale
            },
        },
    })
    flushSync()
    const page = document.querySelector<HTMLElement>(".pdf-image-wrapper")!
    expect(page.style.width).toBe("195px")

    await commandsStore.execute("viewer.zoom.fit-width")
    flushSync()

    expect(store.scale).toBe(1.5)
    expect(page.style.width).toBe("390px")
})
