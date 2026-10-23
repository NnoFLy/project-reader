/** Reject promptly while still observing a non-cooperative boundary's late completion. */
export async function runDocumentOperation<T>(
    signal: AbortSignal,
    operation: () => Promise<T>,
    discard?: (value: T) => void | Promise<void>,
): Promise<T> {
    signal.throwIfAborted()
    let abort!: () => void
    const cancelled = new Promise<never>((_, reject) => {
        abort = () => reject(signal.reason)
        signal.addEventListener("abort", abort, { once: true })
    })
    const pending = Promise.resolve().then(() => {
        signal.throwIfAborted()
        return operation()
    })
    let accepted = false
    try {
        const value = await Promise.race([pending, cancelled])
        signal.throwIfAborted()
        accepted = true
        return value
    } finally {
        signal.removeEventListener("abort", abort)
        // Attach cleanup to the physical result, including the result/abort microtask gap.
        if (!accepted && discard) void pending.then(discard).catch(() => undefined)
    }
}

export function combinedSignal(...signals: (AbortSignal | undefined)[]): AbortSignal {
    return AbortSignal.any(signals.filter((signal): signal is AbortSignal => Boolean(signal)))
}

/** A cleanup deadline limits presentation, never asserts physical resource quiescence. */
export async function boundedDocumentCleanup(operation: Promise<unknown>): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
        await Promise.race([
            operation,
            new Promise<void>((resolve) => {
                timer = setTimeout(resolve, 250)
            }),
        ])
    } finally {
        clearTimeout(timer)
    }
}
