const FOCUSABLE_SELECTOR = [
    "a[href]",
    "area[href]",
    "button:not([disabled])",
    "input:not([disabled]):not([type='hidden'])",
    "select:not([disabled])",
    "textarea:not([disabled])",
    "iframe",
    "[contenteditable='true']",
    "[tabindex]:not([tabindex='-1'])",
].join(",")

export function dismissFocusedInteractiveElement(
    container?: HTMLElement | null,
    activeElement?: Element | null,
): boolean {
    const active =
        activeElement === undefined
            ? typeof document !== "undefined"
                ? document.activeElement
                : null
            : activeElement
    if (typeof HTMLElement === "undefined" || !(active instanceof HTMLElement)) return false
    if (container && !container.contains(active)) return false
    if (
        active.hasAttribute("hidden") ||
        active.getAttribute("aria-hidden") === "true" ||
        !active.matches(FOCUSABLE_SELECTOR)
    )
        return false

    active.blur()
    return true
}

export function getFocusableElements(container: HTMLElement): HTMLElement[] {
    return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
        (element) =>
            !element.hasAttribute("hidden") &&
            element.getAttribute("aria-hidden") !== "true" &&
            element.getClientRects().length > 0,
    )
}

export function trapTabKey(event: KeyboardEvent, container: HTMLElement): void {
    if (event.key !== "Tab") return
    const focusable = getFocusableElements(container)
    if (focusable.length === 0) {
        event.preventDefault()
        container.focus()
        return
    }

    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    const active = document.activeElement
    const activeIsFocusable = active instanceof HTMLElement && focusable.includes(active)
    if (event.shiftKey && (active === first || !activeIsFocusable)) {
        event.preventDefault()
        last.focus()
    } else if (!event.shiftKey && (active === last || !activeIsFocusable)) {
        event.preventDefault()
        first.focus()
    }
}

export function restoreFocus(
    target: HTMLElement | null,
    fallback?: HTMLElement | null,
    closingSurface?: HTMLElement | null,
): void {
    // An asynchronous close must not interrupt another window or the underlying view.
    const active = document.activeElement
    if (closingSurface && active && active !== document.body && !closingSurface.contains(active))
        return
    if (target?.isConnected && !target.closest("[inert]")) {
        target.focus()
    } else if (fallback?.isConnected) {
        fallback.focus()
    }
}
