// @vitest-environment jsdom

import { afterEach, expect, it, vi } from "vitest"
import { createRawSnippet, mount, tick, unmount } from "svelte"
import AppShell from "$lib/app/AppShell.svelte"

vi.hoisted(() => {
    window.matchMedia = (() => ({
        matches: false,
        addEventListener() {},
        removeEventListener() {},
    })) as unknown as typeof window.matchMedia
})
vi.mock("$app/navigation", async (importOriginal) => ({
    ...(await importOriginal<typeof import("$app/navigation")>()),
    pushState: vi.fn(),
    afterNavigate: vi.fn(),
}))
vi.mock("$app/state", () => ({
    updated: { current: false },
    page: { url: new URL("https://reader.test/viewer") },
}))

afterEach(() => {
    vi.unstubAllGlobals()
})

it("gates chrome and direct-route children behind accessible blocked feedback and a keyboard retry", async () => {
    const request = vi.fn(async (_name, _options, callback) => callback(null))
    Object.defineProperty(navigator, "locks", { value: { request }, configurable: true })
    const target = document.createElement("div")
    document.body.append(target)
    const shell = mount(AppShell, {
        target,
        props: {
            children: createRawSnippet(() => ({
                render: () => "<div data-direct-viewer>Direct Viewer route</div>",
            })),
        },
    })
    try {
        await vi.waitFor(() =>
            expect(target.querySelector("h1")?.textContent).toBe(
                "Library is open in another window",
            ),
        )
        expect(target.querySelector("[data-direct-viewer]")).toBeNull()
        expect(target.querySelector("#app-root")).toBeNull()
        expect(target.querySelector('[role="status"]')).not.toBeNull()
        const retry = [...target.querySelectorAll("button")].find(
            (button) => button.textContent?.trim() === "Try again",
        )!
        retry.focus()
        expect(document.activeElement).toBe(retry)
        // Native buttons expose the same click activation to Enter/Space in the browser.
        retry.click()
        await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2))
        await vi.waitFor(() =>
            expect(target.querySelector('[data-writer-state="blocked"]')).not.toBeNull(),
        )
        expect(document.activeElement).toBe(retry)
        expect(target.querySelector("[data-direct-viewer]")).toBeNull()
        window.dispatchEvent(new PageTransitionEvent("pagehide"))
        await tick()
        expect(target.querySelector("[data-direct-viewer]")).toBeNull()
    } finally {
        await unmount(shell)
        target.remove()
        Reflect.deleteProperty(navigator, "locks")
    }
})

it.each(["unsupported", "failed"] as const)(
    "presents safe %s feedback without mounting a route",
    async (state) => {
        Object.defineProperty(navigator, "locks", {
            value:
                state === "unsupported"
                    ? undefined
                    : {
                          request: () => {
                              throw new Error("Private browser details")
                          },
                      },
            configurable: true,
        })
        const target = document.createElement("div")
        document.body.append(target)
        const shell = mount(AppShell, {
            target,
            props: {
                children: createRawSnippet(() => ({
                    render: () => "<div data-direct-viewer>Direct Viewer route</div>",
                })),
            },
        })
        try {
            await vi.waitFor(() =>
                expect(target.querySelector(`[data-writer-state="${state}"]`)).not.toBeNull(),
            )
            expect(target.querySelector("h1")?.textContent).toBe(
                state === "unsupported"
                    ? "This browser cannot safely open the Library"
                    : "Library could not start safely",
            )
            expect(target.textContent).not.toContain("Private browser details")
            expect(target.querySelector("[data-direct-viewer]")).toBeNull()
            expect(
                [...target.querySelectorAll("button")].map((button) => button.textContent?.trim()),
            ).toEqual(["Try again", "Reload page"])
        } finally {
            await unmount(shell)
            target.remove()
            Reflect.deleteProperty(navigator, "locks")
        }
    },
)
