let notify:
    | ((message: string, level?: "info" | "success" | "warning" | "error") => void)
    | undefined

export function configureLibraryNotifications(
    handler: (message: string, level?: "info" | "success" | "warning" | "error") => void,
): void {
    notify = handler
}

export function publishNotification(
    message: string | { line1: string; line2?: string },
    level: "info" | "success" | "warning" | "error" = "info",
): void {
    notify?.(
        typeof message === "string"
            ? message
            : `${message.line1}${message.line2 ? `: ${message.line2}` : ""}`,
        level,
    )
}
