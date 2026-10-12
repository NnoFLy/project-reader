import type { Disposable, Notification, NotificationService } from "../../extension-api"

let notificationSequence = 0

export class NotificationServiceImpl implements NotificationService {
    private readonly notifications = new Map<string, Notification>()
    private readonly handles = new Map<string, Disposable>()
    private readonly listeners = new Set<(notification: Notification) => void>()
    private readonly removalListeners = new Set<(notification: Notification) => void>()

    show(notification: Omit<Notification, "id">): Disposable {
        const value = { ...notification, id: `notification-${++notificationSequence}` }
        this.notifications.set(value.id, value)
        const handle: Disposable = {
            dispose: () => {
                if (!this.notifications.delete(value.id)) return
                this.handles.delete(value.id)
                for (const listener of this.removalListeners) listener(value)
            },
        }
        this.handles.set(value.id, handle)
        for (const listener of this.listeners) listener(value)
        return handle
    }

    info(message: string): Disposable {
        return this.show({ level: "info", message })
    }

    success(message: string): Disposable {
        return this.show({ level: "success", message })
    }

    warning(message: string): Disposable {
        return this.show({ level: "warning", message })
    }

    error(message: string): Disposable {
        return this.show({ level: "error", message })
    }

    list(): readonly Notification[] {
        return [...this.notifications.values()]
    }

    dismiss(id: string): boolean {
        const handle = this.handles.get(id)
        if (!handle) return false
        handle.dispose()
        return true
    }

    subscribe(
        listener: (notification: Notification) => void,
        onRemove?: (notification: Notification) => void,
    ): Disposable {
        this.listeners.add(listener)
        if (onRemove) this.removalListeners.add(onRemove)
        return {
            dispose: () => {
                this.listeners.delete(listener)
                if (onRemove) this.removalListeners.delete(onRemove)
            },
        }
    }
}
