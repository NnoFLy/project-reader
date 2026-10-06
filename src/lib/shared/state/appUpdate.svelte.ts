import { version } from "$app/environment"
import { safeStorageGet, safeStorageRemove, safeStorageSet } from "./safeStorage"

const STORAGE_KEY = "pending_app_update_version"
const SKIP_WAITING_MESSAGE = "SKIP_WAITING"
const CONTROLLER_CHANGE_TIMEOUT = 10_000

function waitForInstall(worker: ServiceWorker) {
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

export async function activateWaitingWorker(registration: ServiceWorkerRegistration) {
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

class AppUpdateState {
    available = $state(false)
    updating = $state(false)

    initialize() {
        const pendingVersion = safeStorageGet(STORAGE_KEY)
        this.available = pendingVersion === version

        if (pendingVersion && pendingVersion !== version) {
            safeStorageRemove(STORAGE_KEY)
        }

        const handleStorage = (event: StorageEvent) => {
            if (event.key === STORAGE_KEY) {
                this.available = event.newValue === version
            }
        }

        const handleControllerChange = () => {
            if (this.available) location.reload()
        }

        window.addEventListener("storage", handleStorage)
        navigator.serviceWorker?.addEventListener("controllerchange", handleControllerChange)

        return () => {
            window.removeEventListener("storage", handleStorage)
            navigator.serviceWorker?.removeEventListener("controllerchange", handleControllerChange)
        }
    }

    markAvailable() {
        if (this.available) return
        this.available = true
        safeStorageSet(STORAGE_KEY, version)
    }

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
    }
}

export const appUpdate = new AppUpdateState()
