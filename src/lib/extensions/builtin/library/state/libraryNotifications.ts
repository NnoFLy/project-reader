import type { Disposable } from "$lib/extension-api"

let notify:
    | ((message: string, level?: "info" | "success" | "warning" | "error") => Disposable | void)
    | undefined

export function configureLibraryNotifications(
    handler:
        | ((message: string, level?: "info" | "success" | "warning" | "error") => Disposable | void)
        | undefined,
): void {
    notify = handler
}

export function publishNotification(
    message: string | { line1: string; line2?: string },
    level: "info" | "success" | "warning" | "error" = "info",
): Disposable | undefined {
    return notify
        ? (notify(
              typeof message === "string"
                  ? message
                  : `${message.line1}${message.line2 ? `: ${message.line2}` : ""}`,
              level,
          ) ?? undefined)
        : undefined
}
