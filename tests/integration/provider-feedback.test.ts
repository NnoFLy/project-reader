// @vitest-environment jsdom

import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { flushSync, mount, unmount } from "svelte"
import ViewerRoute from "$lib/app/routes/ViewerRoute.svelte"
import { APP_HOST_CONTEXT, type AppHostContext } from "$lib/app/hostContext"
import { ApplicationImpl } from "$lib/core/app/application"
import { createBuiltinHost } from "$lib/extensions/builtin"
import { getLocale, setLocale } from "$lib/paraglide/runtime"
import { ExtensionHost } from "$lib/extension-host"
import type { AppExtension, ExtensionContext } from "$lib/extension-api"
import BookIcon from "$lib/shared/icons/BookIcon.svelte"

vi.hoisted(() => {
    window.matchMedia = (() => ({
        matches: false,
        addEventListener() {},
        removeEventListener() {},
    })) as unknown as typeof window.matchMedia
})

vi.mock("$app/navigation", async (importOriginal) => ({
    ...(await importOriginal<typeof import("$app/navigation")>()),
    goto: vi.fn(async () => {}),
    replaceState: vi.fn(),
}))
vi.mock("$app/state", () => ({ page: { url: new URL("https://reader.test/en/viewer") } }))

const originalLocale = getLocale()
const originalHref = window.location.href
beforeEach(() => {
    window.history.replaceState({}, "", "/en/viewer")
    setLocale("en", { reload: false })
})
afterEach(() => {
    window.history.replaceState({}, "", originalHref)
    setLocale(originalLocale, { reload: false })
    document.body.replaceChildren()
})

function mountRoute(application: ApplicationImpl) {
    const context: AppHostContext = {
        application,
        ready: true,
        services: {
            executeCommand: (id, payload) => application.host.commands.execute(id, payload),
        },
    }
    return mount(ViewerRoute, {
        target: document.body,
        context: new Map([[APP_HOST_CONTEXT, context]]),
    })
}

it("shows host-owned translated retry feedback when the real builtin Viewer is disabled", async () => {
    setLocale("en", { reload: false })
    const application = new ApplicationImpl(createBuiltinHost())
    await application.start()
    await application.host.disable("builtin.viewer")
    const route = mountRoute(application)
    try {
        flushSync()
        expect(document.querySelector("h1")?.textContent).toBe("Viewer is unavailable")
        expect(document.querySelector('[role="status"]')).not.toBeNull()
        expect(
            document.querySelector('[data-provider-feedback="viewer.unavailable"]'),
        ).not.toBeNull()
        expect(document.querySelector("button")?.textContent?.trim()).toBe("Try again")
        expect(application.host.providers.get("builtin.viewer")?.state).toBe("disabled")
        retryButton().click()
        await vi.waitFor(() =>
            expect(application.host.providers.get("builtin.viewer")?.state).toBe("active"),
        )
        expect(document.querySelector("[data-provider-feedback]")).toBeNull()
        await application.host.disable("builtin.viewer")
        await vi.waitFor(() => expect(unavailable()).not.toBeNull())
    } finally {
        await unmount(route)
        await application.stop()
    }
})

const unavailable = () => document.querySelector('[data-provider-feedback="viewer.unavailable"]')
const retrying = () => document.querySelector('[data-provider-feedback="viewer.retrying"]')
const retryButton = () => document.querySelector("button")!
const deferred = () => {
    let resolve!: () => void
    const promise = new Promise<void>((done) => (resolve = done))
    return { promise, resolve }
}

function extension(
    id: string,
    activate: AppExtension["activate"] = () => {},
    dependencies?: Record<string, string>,
): AppExtension {
    return {
        manifest: {
            id,
            name: id,
            version: "1.0.0",
            engine: "*",
            entry: id,
            permissions: ["views"],
            activationEvents: [{ type: "startup" }],
            dependencies,
        },
        activate,
    }
}

// A harmless native view probe isolates host route/lifecycle behavior from Viewer internals.
// Every registration, disable, activation, dependency and recovery below uses the real host.
function registerView(context: ExtensionContext) {
    context.views.registerNative({
        id: "viewer.reader",
        kind: "native",
        slot: "viewer.toolbar",
        component: BookIcon,
    })
}

function applicationWith(
    activate: AppExtension["activate"] = registerView,
    dependencies?: Record<string, string>,
    extensions: AppExtension[] = [],
) {
    return new ApplicationImpl(
        new ExtensionHost({
            cleanupTimeoutMs: 10,
            extensions: [...extensions, extension("builtin.viewer", activate, dependencies)],
        }),
    )
}

it("unmounts an unusable registered view and observes external provider recovery without automatic activation", async () => {
    const activate = vi.fn(registerView)
    const application = applicationWith(activate)
    await application.start()
    const route = mountRoute(application)
    try {
        flushSync()
        const firstView = document.querySelector("svg")
        expect(firstView).not.toBeNull()
        await application.host.disable("builtin.viewer")
        flushSync()
        expect(document.querySelector("svg")).toBeNull()
        expect(unavailable()).not.toBeNull()
        expect(activate).toHaveBeenCalledOnce()
        await application.host.enable("builtin.viewer")
        flushSync()
        expect(unavailable()).not.toBeNull()
        expect(activate).toHaveBeenCalledOnce()
        await application.host.activate("builtin.viewer")
        flushSync()
        expect(unavailable()).toBeNull()
        expect(document.querySelectorAll("svg")).toHaveLength(1)
        expect(document.querySelector("svg")).not.toBe(firstView)
    } finally {
        await unmount(route)
        await application.stop()
    }
})

it("keeps retry mounted and focused through pending and failed retries without exposing exceptions", async () => {
    const finish = deferred()
    let attempts = 0
    const application = applicationWith(async (context) => {
        attempts++
        registerView(context)
        if (attempts === 2) await finish.promise
        if (attempts < 3) throw new Error("Private document, draft and stack details")
    })
    await application.start()
    const route = mountRoute(application)
    try {
        flushSync()
        expect(unavailable()).not.toBeNull()
        expect(document.body.textContent).not.toContain("Private")
        const button = retryButton()
        button.focus()
        button.click()
        await vi.waitFor(() => expect(attempts).toBe(2))
        flushSync()
        expect(retrying()).not.toBeNull()
        expect(document.querySelector("svg")).toBeNull()
        expect(button.getAttribute("aria-disabled")).toBe("true")
        expect(button.disabled).toBe(false)
        expect(button.textContent).toBe("Trying again…")
        button.click()
        expect(attempts).toBe(2)
        expect(document.activeElement).toBe(button)
        finish.resolve()
        await vi.waitFor(() => expect(unavailable()).not.toBeNull())
        expect(retryButton()).toBe(button)
        expect(button.getAttribute("aria-disabled")).toBe("false")
        expect(document.activeElement).toBe(button)
        expect(document.body.textContent).not.toContain("Private")
        expect(document.body.textContent).not.toContain("stack")
        button.click()
        await vi.waitFor(() => expect(document.querySelector("svg")).not.toBeNull())
        expect(document.querySelectorAll("svg")).toHaveLength(1)
        expect(unavailable()).toBeNull()
        expect(attempts).toBe(3)
    } finally {
        finish.resolve()
        await unmount(route)
        await application.stop()
    }
})

it("explicitly recovers only missing required dependencies in order before Viewer", async () => {
    const activations: string[] = []
    const record = (id: string) => () => {
        activations.push(id)
    }
    const unrelated = extension("test.unrelated", record("test.unrelated"))
    const lazy = extension("test.format", record("test.format"))
    const application = applicationWith(
        (context) => {
            activations.push("builtin.viewer")
            registerView(context)
        },
        { "builtin.settings": "*", "builtin.library": "*" },
        [
            extension("test.storage", record("test.storage")),
            extension("builtin.settings", record("builtin.settings"), { "test.storage": "*" }),
            extension("builtin.library", record("builtin.library")),
            unrelated,
            {
                ...lazy,
                manifest: {
                    ...lazy.manifest,
                    activationEvents: [{ type: "onDocumentType", extension: "fake" }],
                },
            },
        ],
    )
    await application.start()
    for (const id of ["test.storage", "builtin.settings", "test.unrelated", "builtin.viewer"])
        await application.host.disable(id)
    activations.length = 0
    const route = mountRoute(application)
    try {
        flushSync()
        expect(activations).toEqual([])
        retryButton().click()
        await vi.waitFor(() => expect(document.querySelector("svg")).not.toBeNull())
        expect(activations).toEqual(["test.storage", "builtin.settings", "builtin.viewer"])
        expect(application.host.providers.get("builtin.library")?.state).toBe("active")
        expect(application.host.providers.get("test.unrelated")?.state).toBe("disabled")
        expect(application.host.providers.get("test.format")?.state).toBe("enabled")
    } finally {
        await unmount(route)
        await application.stop()
    }
})

it("keeps safe focused feedback when obsolete activation blocks host recovery, then permits an explicit retry", async () => {
    const finish = deferred()
    let attempts = 0
    const application = applicationWith(async (context) => {
        if (++attempts === 1) await finish.promise
        if (!context.lifecycle.signal?.aborted) registerView(context)
    })
    const starting = application.start()
    await vi.waitFor(() => expect(attempts).toBe(1))
    await application.host.disable("builtin.viewer")
    const route = mountRoute(application)
    try {
        flushSync()
        const button = retryButton()
        button.focus()
        button.click()
        flushSync()
        expect(retrying()).not.toBeNull()
        await vi.waitFor(() => expect(unavailable()).not.toBeNull())
        expect(document.activeElement).toBe(button)
        expect(retryButton()).toBe(button)
        expect(attempts).toBe(1)
        expect(application.host.providers.get("builtin.viewer")?.state).toBe("disabled")
        expect(document.body.textContent).not.toContain("Error")
        finish.resolve()
        await starting
        expect(unavailable()).not.toBeNull()
        button.click()
        await vi.waitFor(() => expect(document.querySelector("svg")).not.toBeNull())
        expect(attempts).toBe(2)
    } finally {
        finish.resolve()
        await starting
        await unmount(route)
        await application.stop()
    }
})

it("does not continue a stale retry or take focus after unmount and a new route", async () => {
    const finish = deferred()
    let dependencyAttempts = 0
    let viewerAttempts = 0
    const application = applicationWith(
        (context) => {
            viewerAttempts++
            registerView(context)
        },
        { "test.dependency": "*" },
        [
            extension("test.dependency", async () => {
                if (++dependencyAttempts === 2) await finish.promise
            }),
        ],
    )
    await application.start()
    await application.host.disable("builtin.viewer")
    await application.host.disable("test.dependency")
    let route = mountRoute(application)
    try {
        flushSync()
        retryButton().click()
        await vi.waitFor(() => expect(dependencyAttempts).toBe(2))
        await unmount(route)
        route = mountRoute(application)
        flushSync()
        const newRetry = retryButton()
        newRetry.focus()
        finish.resolve()
        await vi.waitFor(() =>
            expect(application.host.providers.get("test.dependency")?.state).toBe("active"),
        )
        flushSync()
        expect(viewerAttempts).toBe(1)
        expect(application.host.providers.get("builtin.viewer")?.state).toBe("disabled")
        expect(unavailable()).not.toBeNull()
        expect(document.activeElement).toBe(newRetry)
        newRetry.click()
        await vi.waitFor(() => expect(document.querySelector("svg")).not.toBeNull())
        expect(viewerAttempts).toBe(2)
    } finally {
        finish.resolve()
        await unmount(route)
        await application.stop()
    }
})

it("cancels the retry sequence if a required provider is disabled again during recovery", async () => {
    const finish = deferred()
    let dependencyAttempts = 0
    const activateViewer = vi.fn(registerView)
    const application = applicationWith(activateViewer, { "test.dependency": "*" }, [
        extension("test.dependency", async () => {
            if (++dependencyAttempts === 2) await finish.promise
        }),
    ])
    await application.start()
    await application.host.disable("builtin.viewer")
    await application.host.disable("test.dependency")
    const route = mountRoute(application)
    try {
        flushSync()
        const button = retryButton()
        button.focus()
        button.click()
        await vi.waitFor(() => expect(dependencyAttempts).toBe(2))
        await application.host.disable("test.dependency")
        const otherControl = document.createElement("button")
        document.body.append(otherControl)
        otherControl.focus()
        finish.resolve()
        await vi.waitFor(() => expect(unavailable()).not.toBeNull())
        expect(activateViewer).toHaveBeenCalledOnce()
        expect(document.activeElement).toBe(otherControl)
        expect(document.querySelector("svg")).toBeNull()
    } finally {
        finish.resolve()
        await unmount(route)
        await application.stop()
    }
})

it("does not read the host or render a route while the application writer gate is not ready", async () => {
    const application = vi.fn(() => {
        throw new Error("Writer gate is closed")
    })
    const context: AppHostContext = {
        get application() {
            return application()
        },
        ready: false,
        services: { executeCommand: vi.fn() },
    }
    const route = mount(ViewerRoute, {
        target: document.body,
        context: new Map([[APP_HOST_CONTEXT, context]]),
    })
    try {
        flushSync()
        expect(application).not.toHaveBeenCalled()
        expect(unavailable()).toBeNull()
        expect(document.querySelector("svg")).toBeNull()
    } finally {
        await unmount(route)
    }
})

it("uses the Russian catalog for safe unavailable and pending retry instructions", async () => {
    window.history.replaceState({}, "", "/viewer")
    setLocale("ru", { reload: false })
    const finish = deferred()
    let attempts = 0
    const application = applicationWith(async () => {
        if (++attempts === 2) await finish.promise
        throw new Error("Private details")
    })
    await application.start()
    const route = mountRoute(application)
    try {
        flushSync()
        expect(document.querySelector("h1")?.textContent).toBe("Просмотр недоступен")
        expect(document.querySelector('[role="status"]')?.textContent).toContain(
            "Состояние чтения и черновики сохранены. Повторите попытку, чтобы восстановить доступ.",
        )
        const button = retryButton()
        expect(button.textContent).toBe("Повторить попытку")
        button.click()
        await vi.waitFor(() => expect(attempts).toBe(2))
        flushSync()
        expect(button.textContent).toBe("Повторная попытка…")
        expect(document.querySelector('[role="status"]')?.textContent).toContain(
            "Повторная попытка…",
        )
        finish.resolve()
        await vi.waitFor(() => expect(unavailable()).not.toBeNull())
        expect(document.body.textContent).not.toContain("Private")
    } finally {
        finish.resolve()
        await unmount(route)
        await application.stop()
    }
})
