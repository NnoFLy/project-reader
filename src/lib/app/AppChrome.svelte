<script lang="ts">
    import { getContext, onMount } from "svelte"
    import { SvelteMap } from "svelte/reactivity"
    import type { Component } from "svelte"
    import type { ContextualStatus, Notification } from "$lib/extension-api"
    import { version } from "$app/environment"
    import { updated } from "$app/state"
    import { afterNavigate } from "$app/navigation"
    import { APP_HOST_CONTEXT, type AppHostContext } from "./hostContext"

    const STORAGE_KEY = "pending_app_update_version"
    const SKIP_WAITING_MESSAGE = "SKIP_WAITING"
    const CONTROLLER_CHANGE_TIMEOUT = 10_000
    const NOTIFICATION_TIMEOUT = 5_000

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
    let promptOpen = $derived(hostContext.application.host.prompt?.promptStore.isOpen ?? false)
    let statusViews = $derived(
        ready ? hostContext.application.host.contributions.listViews("host.status") : [],
    )
    let contextualStatus = $state<ContextualStatus | null>(null)
    const contextualStatusPublishers = new SvelteMap<
        string,
        ReturnType<typeof hostContext.application.host.contextualStatus.forExtension>
    >()
    const statusPublisherFor = (extensionId: string) => {
        let publisher = contextualStatusPublishers.get(extensionId)
        if (!publisher) {
            publisher = hostContext.application.host.contextualStatus.forExtension(extensionId)
            contextualStatusPublishers.set(extensionId, publisher)
        }
        return publisher
    }
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

        const contextualStatusService = hostContext.application.host.contextualStatus
        const statusSubscription = contextualStatusService.subscribe((status) => {
            contextualStatus = status
        })
        const notificationService = hostContext.application.host.notifications
        const notificationTimers = new SvelteMap<string, number>()
        const removeFromView = (id: string) => {
            const timer = notificationTimers.get(id)
            if (timer !== undefined) window.clearTimeout(timer)
            notificationTimers.delete(id)
            notifications = notifications.filter((current) => current.id !== id)
        }
        const dismiss = (id: string) => {
            removeFromView(id)
            notificationService.dismiss(id)
        }
        const show = (notification: Notification) => {
            // Replacing the view must not dispose the service handle for a newly shown
            // notification. The service owns that handle and its caller may still need it.
            removeFromView(notification.id)
            notifications = [...notifications, notification]
            notificationTimers.set(
                notification.id,
                window.setTimeout(() => dismiss(notification.id), NOTIFICATION_TIMEOUT),
            )
        }
        for (const notification of notificationService.list()) show(notification)
        const subscription = notificationService.subscribe(show, (notification) => {
            const timer = notificationTimers.get(notification.id)
            if (timer !== undefined) window.clearTimeout(timer)
            notificationTimers.delete(notification.id)
            notifications = notifications.filter((current) => current.id !== notification.id)
        })
        return () => {
            statusSubscription.dispose()
            contextualStatusPublishers.clear()
            subscription.dispose()
            for (const timer of notificationTimers.values()) window.clearTimeout(timer)
            notificationTimers.clear()
        }
    })
</script>

<div id="app-root">
    <div class="app">
        {@render children()}

        {#each statusViews as view (view.id)}
            {@const View = view.component as Component}
            {#if View}
                <View contextualStatus={statusPublisherFor(view.extensionId)} />
            {/if}
        {/each}

        {#if contextualStatus}
            <section
                class="host-contextual-status"
                aria-label={contextualStatus.line2}
                role="status"
            >
                <strong>{contextualStatus.line1}</strong>
                <span>{contextualStatus.line2}</span>
            </section>
        {/if}

        {#each promptViews as view (view.id)}
            {@const View = view.component as Component}
            {#if View && (view.id !== "prompt.palette" || promptOpen)}
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

    .host-contextual-status {
        position: fixed;
        z-index: 999;
        inset: auto auto 1.25rem 1.25rem;
        display: grid;
        gap: 0.1rem;
        min-width: 5.5rem;
        padding: 0.6rem 0.85rem;
        border: var(--border-inline) solid var(--border-color);
        border-radius: var(--radius-md);
        color: var(--text-color);
        background: var(--surface-color);
        box-shadow: var(--shadow-elevated);
        font: var(--font-size-sm) / 1.25 var(--ui-font);
        text-align: center;
        pointer-events: none;
    }

    .host-contextual-status strong {
        font-size: 1.05rem;
    }

    .host-contextual-status span {
        color: var(--faded-text-color);
        font-family: var(--ui-mono-font);
        font-size: var(--font-size-xs);
        letter-spacing: 0.02em;
    }

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
        border: var(--border-inline) solid var(--border-color);
        border-radius: var(--radius-md);
        padding: 0.7rem 0.85rem;
        color: var(--text-color);
        background: var(--surface-color);
        box-shadow: var(--shadow-elevated);
        font: var(--font-size-sm) / 1.4 var(--ui-font);
    }

    .host-notification-success {
        border-color: var(--color-action);
    }

    .host-notification-warning {
        border-color: var(--color-marker);
    }

    .host-notification-error {
        border-color: var(--color-danger);
    }
</style>
