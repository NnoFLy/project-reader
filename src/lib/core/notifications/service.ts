import type { Disposable, Notification, NotificationService } from "../../extension-api"

let notificationSequence = 0

export class NotificationServiceImpl implements NotificationService {
    private readonly notifications = new Map<string, Notification>()
    private readonly listeners = new Set<(notification: Notification) => void>()

    show(notification: Omit<Notification, "id">): Disposable {
        const value = { ...notification, id: `notification-${++notificationSequence}` }
        this.notifications.set(value.id, value)
        for (const listener of this.listeners) listener(value)
        return {
            dispose: () => {
                this.notifications.delete(value.id)
            },
        }
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

    subscribe(listener: (notification: Notification) => void): Disposable {
        this.listeners.add(listener)
        return {
            dispose: () => {
                this.listeners.delete(listener)
            },
        }
    }
}
