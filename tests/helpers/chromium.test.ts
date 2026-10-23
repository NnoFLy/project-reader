import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { BrowserPage } from "./chromium"

type Response = {
    result?: { result?: { value?: unknown }; exceptionDetails?: unknown }
    error?: { message: string }
}

let page: BrowserPage | undefined

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
    page?.close()
    page = undefined
    vi.useRealTimers()
    vi.unstubAllGlobals()
})

// Fake only the external WebSocket/CDP boundary; connect and poll through the public API.
async function connect(evaluate: (expression: string) => Response | "close" | "error") {
    class Socket extends EventTarget {
        static OPEN = 1
        readyState = Socket.OPEN
        constructor() {
            super()
            queueMicrotask(() => this.dispatchEvent(new Event("open")))
        }
        send(data: string) {
            const { id, method, params } = JSON.parse(data)
            const response =
                method === "Runtime.evaluate" ? evaluate(params.expression) : { result: {} }
            queueMicrotask(() => {
                if (response === "close") this.close()
                else if (response === "error") this.dispatchEvent(new Event("error"))
                else
                    this.dispatchEvent(
                        new MessageEvent("message", { data: JSON.stringify({ id, ...response }) }),
                    )
            })
        }
        close() {
            this.readyState = 3
            this.dispatchEvent(new Event("close"))
        }
    }
    vi.stubGlobal("WebSocket", Socket)
    page = await BrowserPage.connect("ws://cdp.test/page", "page")
    return page
}

describe("BrowserPage.waitFor", () => {
    it.each([
        "Inspected target navigated or closed",
        "Execution context was destroyed.",
        "Cannot find context with specified id",
    ])("keeps polling readiness after CDP reports %s", async (message) => {
        let navigating = true
        const page = await connect(() => {
            if (navigating) {
                navigating = false
                return { error: { message } }
            }
            return { result: { result: { value: "ready" } } }
        })
        const ready = expect(page.waitFor("document.readyState === 'complete'")).resolves.toBe(
            "ready",
        )
        await Promise.all([ready, vi.advanceTimersByTimeAsync(50)])
    })

    it("continues polling a false predicate until it becomes true", async () => {
        let ready = false
        const page = await connect(() => ({ result: { result: { value: ready } } }))
        const result = expect(page.waitFor("ready")).resolves.toBe(true)
        await vi.advanceTimersByTimeAsync(50)
        ready = true
        await Promise.all([result, vi.advanceTimersByTimeAsync(50)])
    })

    it.each(["false predicate", "navigation interrupted"])(
        "preserves the readiness deadline and diagnostics for %s",
        async (condition) => {
            const page = await connect((expression) => {
                if (expression === "document.body.innerText")
                    return { result: { result: { value: "Still loading" } } }
                return condition === "false predicate"
                    ? { result: { result: { value: false } } }
                    : { error: { message: "Inspected target navigated or closed" } }
            })
            const start = Date.now()
            const result = expect(page.waitFor("ready")).rejects.toThrow(
                "Browser condition timed out: ready; Still loading; errors: []",
            )
            await Promise.all([result, vi.advanceTimersByTimeAsync(30000)])
            expect(Date.now() - start).toBe(30000)
        },
    )

    it.each(["Access denied", "Assertion failed", "Unknown CDP command"])(
        "immediately propagates unrelated CDP errors: %s",
        async (message) => {
            const page = await connect(() => ({ error: { message } }))
            await expect(page.waitFor("ready")).rejects.toThrow(message)
        },
    )

    it.each([
        "Inspected target navigated or closed",
        "Execution context was destroyed.",
        "Cannot find context with specified id",
        "SecurityError: Access denied",
        "AssertionError: expected saved draft",
    ])("does not retry application exceptions containing %s", async (description) => {
        const page = await connect(() => ({ result: { exceptionDetails: { description } } }))
        await expect(page.waitFor("ready")).rejects.toThrow(description)
    })

    it.each([
        ["close", "Browser page closed"],
        ["error", "Browser connection failed"],
    ] as const)("propagates transport %s while waiting", async (event, message) => {
        const page = await connect(() => event)
        await expect(page.waitFor("ready")).rejects.toThrow(message)
    })

    it("rejects readiness polling on an already closed transport", async () => {
        const page = await connect(() => ({ result: { result: { value: true } } }))
        page.close()
        await expect(page.waitFor("ready")).rejects.toThrow("Browser page closed")
    })

    it.each(["evaluate", "call"] as const)(
        "does not retry side-effecting %s operations after navigation errors",
        async (operation) => {
            let executions = 0
            const page = await connect(() => {
                executions++
                return { error: { message: "Inspected target navigated or closed" } }
            })
            const result =
                operation === "evaluate"
                    ? page.evaluate("saveDraft()")
                    : page.call("Runtime.evaluate", { expression: "saveDraft()" })
            await expect(result).rejects.toThrow("Inspected target navigated or closed")
            expect(executions).toBe(1)
        },
    )
})
