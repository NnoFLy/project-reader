// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { createRawSnippet, flushSync, mount, unmount } from "svelte"
import { ApplicationImpl } from "$lib/core/app/application"
import { ExtensionHost } from "$lib/extension-host"
import LibraryStatus from "$lib/extensions/builtin/library/LibraryStatus.svelte"
import { vfsStore } from "$lib/extensions/builtin/library/state/libraryStore.svelte"
import AppChrome from "$lib/app/AppChrome.svelte"
import { APP_HOST_CONTEXT, type AppHostContext } from "$lib/app/hostContext"

vi.mock("$app/environment", () => ({ version: "test", browser: false }))
vi.mock("$app/navigation", () => ({ afterNavigate: vi.fn() }))
vi.mock("$app/state", () => ({
    updated: { current: false },
    page: { url: new URL("https://localhost/en") },
}))
vi.mock("$lib/paraglide/messages", () => ({ selected_label: () => "SELECTED" }))
vi.mock("$lib/extensions/builtin/library/state/libraryStore.svelte", async () => {
    const { SvelteSet } = await import("svelte/reactivity")
    return { vfsStore: { selectedIds: new SvelteSet(["book-1", "book-2"]), activeImportCount: 0 } }
})

afterEach(() => {
    document.body.replaceChildren()
    window.localStorage.clear()
})

describe("AppChrome contextual status", () => {
    it("renders a status publisher prop without mutating reactive state during evaluation", async () => {
        const application = new ApplicationImpl(
            new ExtensionHost({
                extensions: [
                    {
                        manifest: {
                            id: "builtin.library",
                            name: "Library",
                            version: "0.0.1",
                            engine: ">=0.0.1",
                            entry: "builtin.library",
                            activationEvents: [{ type: "startup" }],
                            permissions: ["views"],
                        },
                        activate: ({ views }) => {
                            views.registerNative({
                                id: "library.status",
                                kind: "native",
                                slot: "host.status",
                                component: LibraryStatus,
                            })
                        },
                    },
                ],
            }),
        )
        await application.start()
        const forExtension = vi.spyOn(application.host.contextualStatus, "forExtension")
        const hostContext: AppHostContext = {
            application,
            ready: true,
            services: { executeCommand: vi.fn() },
        }
        const component = mount(AppChrome, {
            target: document.body,
            context: new Map([[APP_HOST_CONTEXT, hostContext]]),
            props: { children: createRawSnippet(() => ({ render: () => "<div></div>" })) },
        })

        try {
            flushSync()
            expect(document.querySelector('[role="status"]')?.textContent).toContain("2")
            expect(document.querySelector('[role="status"]')?.textContent).toContain("SELECTED")

            vfsStore.selectedIds.add("book-3")
            flushSync()
            expect(document.querySelector('[role="status"] strong')?.textContent).toBe("3")
            expect(forExtension).toHaveBeenCalledExactlyOnceWith("builtin.library")
        } finally {
            await unmount(component)
            await application.stop()
            vfsStore.selectedIds.delete("book-3")
        }
    })
})
