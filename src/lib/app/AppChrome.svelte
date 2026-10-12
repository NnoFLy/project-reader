<script lang="ts">
    import { getContext, onMount } from "svelte"
    import type { Component } from "svelte"
    import type { Notification } from "$lib/extension-api"
    import { version } from "$app/environment"
    import { updated } from "$app/state"
    import { afterNavigate } from "$app/navigation"
    import { APP_HOST_CONTEXT, type AppHostContext } from "./hostContext"

    const STORAGE_KEY = "pending_app_update_version"
    const SKIP_WAITING_MESSAGE = "SKIP_WAITING"
    const CONTROLLER_CHANGE_TIMEOUT = 10_000

    function safeStorageSet(key: string, value: string): boolean {
        try {
            if (typeof window !== "undefined") window.localStorage?.setItem(key, value)
            return true
        } catch {
            return false
        }
    }

    function waitForInstall(worker: ServiceWorker): Promise<void> {
        if (worker.state === "installed") return Promise.resolve()

        return new Promise<void>((resolve, reject) => {
            const handleStateChange = () => {
                if (worker.state === "installed") {
                    worker.removeEventListener("statechange", handleStateChange)
                    resolve()
                } else if (worker.state === "redundant") {
                    worker.removeEventListener("statechange", handleStateChange)
                    reject(new Error("The updated service worker became redundant"))
                }
            }

            worker.addEventListener("statechange", handleStateChange)
        })
    }

    async function activateWaitingWorker(registration: ServiceWorkerRegistration): Promise<void> {
        let resolveControllerChange: () => void
        let timeout: number | undefined
        const controllerChanged = new Promise<void>((resolve) => {
            resolveControllerChange = resolve
        })
        const handleControllerChange = () => resolveControllerChange()

        navigator.serviceWorker.addEventListener("controllerchange", handleControllerChange)

        try {
            await registration.update()

            if (!registration.waiting && registration.installing) {
                await waitForInstall(registration.installing)
            }

            const waitingWorker = registration.waiting
            if (!waitingWorker) return

            waitingWorker.postMessage({ type: SKIP_WAITING_MESSAGE })

            const timedOut = new Promise<void>((resolve) => {
                timeout = window.setTimeout(resolve, CONTROLLER_CHANGE_TIMEOUT)
            })
            await Promise.race([controllerChanged, timedOut])
        } finally {
            if (timeout !== undefined) window.clearTimeout(timeout)
            navigator.serviceWorker.removeEventListener("controllerchange", handleControllerChange)
        }
    }

    const appUpdate = {
        available: false,
        updating: false,
        initialize() {
            const pendingVersion = (() => {
                try {
                    return typeof window === "undefined"
                        ? null
                        : (window.localStorage?.getItem(STORAGE_KEY) ?? null)
                } catch {
                    return null
                }
            })()
            this.available = pendingVersion === version

            if (pendingVersion && pendingVersion !== version) {
                try {
                    window.localStorage?.removeItem(STORAGE_KEY)
                } catch {
                    // Storage can be unavailable even after initialization succeeds.
                }
            }

            const handleStorage = (event: StorageEvent) => {
                if (event.key === STORAGE_KEY) this.available = event.newValue === version
            }

            const handleControllerChange = () => {
                if (this.available) location.reload()
            }

            window.addEventListener("storage", handleStorage)
            navigator.serviceWorker?.addEventListener("controllerchange", handleControllerChange)

            return () => {
                window.removeEventListener("storage", handleStorage)
                navigator.serviceWorker?.removeEventListener(
                    "controllerchange",
                    handleControllerChange,
                )
            }
        },
        markAvailable() {
            if (this.available) return
            this.available = true
            safeStorageSet(STORAGE_KEY, version)
        },
        async update() {
            if (this.updating) return
            this.updating = true

            try {
                if ("serviceWorker" in navigator) {
                    const registration = await navigator.serviceWorker.getRegistration()
                    if (registration) await activateWaitingWorker(registration)
                }

                location.reload()
            } catch (error) {
                console.error("[App Update] Failed to activate update", error)
                this.updating = false
            }
        },
    }

    let { children } = $props()
    const hostContext = getContext<AppHostContext>(APP_HOST_CONTEXT)
    let ready = $derived(hostContext.ready)
    let promptViews = $derived(
        ready ? hostContext.application.host.contributions.listViews("prompt.result") : [],
    )
    let notifications = $state<Notification[]>([])

    afterNavigate(({ to }) => {
        if (!to) return
        const { pathname, search } = to.url
        if (
            pathname === "/" ||
            pathname === "/viewer" ||
            pathname === "/en" ||
            pathname === "/en/viewer"
        ) {
            safeStorageSet("last_visited_url", pathname + search)
        }
    })

    onMount(() => {
        appUpdate.initialize()
        if (updated.current) appUpdate.markAvailable()

        const notificationService = hostContext.application.host.notifications
        notifications = [...notificationService.list()]
        const subscription = notificationService.subscribe(
            (notification) => {
                notifications = [
                    ...notifications.filter((current) => current.id !== notification.id),
                    notification,
                ]
            },
            (notification) => {
                notifications = notifications.filter((current) => current.id !== notification.id)
            },
        )
        return () => subscription.dispose()
    })
</script>

<div id="app-root">
    <div class="app">
        {@render children()}

        {#each promptViews as view (view.id)}
            {@const View = view.component as Component}
            {#if View}
                <View />
            {/if}
        {/each}

        {#if notifications.length > 0}
            <section class="host-notifications" aria-label="Notifications">
                {#each notifications as notification (notification.id)}
                    <div
                        class={`host-notification host-notification-${notification.level}`}
                        role={notification.level === "error" ? "alert" : "status"}
                        aria-live={notification.level === "error" ? "assertive" : "polite"}
                        aria-atomic="true"
                    >
                        <span>{notification.message}</span>
                    </div>
                {/each}
            </section>
        {/if}
    </div>
</div>

<style global>
    @import "$lib/shared/styles/variables.css";
    @import "$lib/shared/styles/typography.css";
    @import "$lib/shared/styles/global.css";

    .host-notifications {
        position: fixed;
        z-index: 1000;
        inset: auto 1.25rem 1.25rem auto;
        display: grid;
        gap: 0.65rem;
        width: min(24rem, calc(100vw - 2.5rem));
        pointer-events: none;
    }

    .host-notification {
        border: 1px solid hsl(220 20% 35% / 0.8);
        border-radius: 0.75rem;
        padding: 0.8rem 1rem;
        color: hsl(210 30% 96%);
        background: hsl(222 26% 15% / 0.96);
        box-shadow: 0 0.75rem 2rem hsl(220 40% 4% / 0.32);
        font: 0.875rem/1.4 var(--font-sans, sans-serif);
    }

    .host-notification-success {
        border-color: hsl(145 55% 42% / 0.9);
    }

    .host-notification-warning {
        border-color: hsl(38 85% 52% / 0.9);
    }

    .host-notification-error {
        border-color: hsl(0 72% 58% / 0.9);
    }
</style>
