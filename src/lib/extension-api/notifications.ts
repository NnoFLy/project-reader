import type { Disposable } from "./contracts"

export type NotificationLevel = "info" | "success" | "warning" | "error"

export interface Notification {
    readonly id: string
    readonly level: NotificationLevel
    readonly message: string
    readonly source?: string
    readonly details?: string
}

export interface NotificationService {
    show(notification: Omit<Notification, "id">): Disposable
    info(message: string): Disposable
    success(message: string): Disposable
    warning(message: string): Disposable
    error(message: string): Disposable
    list(): readonly Notification[]
    /** Dispose the service handle for a visible notification. */
    dismiss(id: string): boolean
    subscribe(
        listener: (notification: Notification) => void,
        onRemove?: (notification: Notification) => void,
    ): Disposable
}
