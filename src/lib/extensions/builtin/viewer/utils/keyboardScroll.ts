const SCROLL_DURATION_MS = 180
const INTERRUPT_EVENTS = ["wheel", "touchstart", "pointerdown"] as const
const activeScrolls = new WeakMap<HTMLElement, () => void>()

/** App-controlled scrolling, independent of native smooth-scroll accessibility overrides. */
export function createKeyboardScroller() {
    let frame: number | undefined
    let activeContainer: HTMLElement | undefined

    function cancel() {
        if (frame !== undefined) cancelAnimationFrame(frame)
        frame = undefined
        for (const event of INTERRUPT_EVENTS) {
            activeContainer?.removeEventListener(event, cancel)
        }
        if (activeContainer) activeScrolls.delete(activeContainer)
        activeContainer = undefined
    }

    function scrollBy(
        container: HTMLElement,
        amount: number,
        animate: boolean,
        duration = SCROLL_DURATION_MS,
    ) {
        cancel()
        // Page navigation and smaller keyboard steps must not animate the same pane concurrently.
        activeScrolls.get(container)?.()
        const start = container.scrollTop
        const destination = Math.max(
            0,
            Math.min(start + amount, container.scrollHeight - container.clientHeight),
        )
        if (!animate || start === destination) {
            container.scrollTo({ top: destination, behavior: "instant" })
            return
        }

        activeContainer = container
        activeScrolls.set(container, cancel)
        for (const event of INTERRUPT_EVENTS) {
            container.addEventListener(event, cancel, { passive: true })
        }
        const started = performance.now()
        function tick(now: number) {
            const progress = Math.min(1, Math.max(0, (now - started) / duration))
            const eased = 1 - (1 - progress) ** 3
            container.scrollTo({ top: start + (destination - start) * eased, behavior: "instant" })
            if (progress < 1) {
                frame = requestAnimationFrame(tick)
            } else {
                cancel()
            }
        }
        frame = requestAnimationFrame(tick)
    }

    return {
        scrollBy,
        cancel,
        get isScrolling() {
            return frame !== undefined
        },
    }
}
