import { spawn, type ChildProcess } from "node:child_process"

export const chromiumPath = process.env.CHROMIUM_PATH ?? "/usr/sbin/chromium"
const commandTimeout = 10000

type Reply = { result?: { value?: unknown }; exceptionDetails?: unknown }
type Message = {
    id?: number
    method?: string
    params?: { exceptionDetails?: unknown }
    result?: Reply
    error?: { message: string }
}

export class BrowserPage {
    private sequence = 0
    readonly errors: unknown[] = []
    private pending = new Map<
        number,
        { resolve: (value: Reply) => void; reject: (error: Error) => void }
    >()

    private constructor(
        private readonly socket: WebSocket,
        readonly targetId: string,
    ) {
        socket.addEventListener("message", (event) => {
            const message = JSON.parse(String(event.data)) as Message
            if (message.method === "Runtime.exceptionThrown")
                this.errors.push(message.params?.exceptionDetails)
            if (message.id === undefined) return
            const pending = this.pending.get(message.id)
            if (!pending) return
            this.pending.delete(message.id)
            if (message.error) pending.reject(new Error(message.error.message))
            else pending.resolve(message.result ?? {})
        })
        socket.addEventListener("close", () => this.rejectPending("Browser page closed"))
        socket.addEventListener("error", () => this.rejectPending("Browser connection failed"))
    }

    static async connect(endpoint: string, targetId: string): Promise<BrowserPage> {
        const socket = new WebSocket(endpoint)
        const page = new BrowserPage(socket, targetId)
        try {
            await new Promise<void>((resolve, reject) => {
                const timeout = setTimeout(
                    () => finish(new Error("Browser connection timed out")),
                    commandTimeout,
                )
                const opened = () => finish()
                const failed = () => finish(new Error("Browser connection failed"))
                const finish = (error?: Error) => {
                    clearTimeout(timeout)
                    socket.removeEventListener("open", opened)
                    socket.removeEventListener("error", failed)
                    socket.removeEventListener("close", failed)
                    if (error) reject(error)
                    else resolve()
                }
                socket.addEventListener("open", opened, { once: true })
                socket.addEventListener("error", failed, { once: true })
                socket.addEventListener("close", failed, { once: true })
            })
            await page.call("Page.enable")
            await page.call("Runtime.enable")
            return page
        } catch (error) {
            page.close()
            throw error
        }
    }

    call(method: string, params: Record<string, unknown> = {}): Promise<Reply> {
        return new Promise((resolve, reject) => {
            if (this.socket.readyState !== WebSocket.OPEN) {
                reject(new Error("Browser page closed"))
                return
            }
            const id = ++this.sequence
            const timeout = setTimeout(() => {
                this.pending.delete(id)
                reject(new Error(`Browser command timed out: ${method}`))
            }, commandTimeout)
            this.pending.set(id, {
                resolve: (value) => {
                    clearTimeout(timeout)
                    resolve(value)
                },
                reject: (error) => {
                    clearTimeout(timeout)
                    reject(error)
                },
            })
            try {
                this.socket.send(JSON.stringify({ id, method, params }))
            } catch (error) {
                this.pending.delete(id)
                clearTimeout(timeout)
                reject(error)
            }
        })
    }

    async evaluate(expression: string): Promise<unknown> {
        const reply = await this.call("Runtime.evaluate", {
            expression,
            awaitPromise: true,
            returnByValue: true,
        })
        if (reply.exceptionDetails) throw new Error(JSON.stringify(reply.exceptionDetails))
        return reply.result?.value
    }

    async waitFor(expression: string): Promise<unknown> {
        const deadline = Date.now() + 30000
        do {
            const result = await this.evaluate(expression)
            if (result) return result
            await new Promise((resolve) => setTimeout(resolve, 50))
        } while (Date.now() < deadline)
        throw new Error(
            `Browser condition timed out: ${expression}; ${await this.evaluate("document.body.innerText")}; errors: ${JSON.stringify(this.errors)}`,
        )
    }

    private rejectPending(message: string) {
        for (const pending of this.pending.values()) pending.reject(new Error(message))
        this.pending.clear()
    }

    close() {
        this.rejectPending("Browser page closed")
        this.socket.close()
    }
}

export async function terminate(child: ChildProcess | undefined) {
    if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return
    await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
            child.removeListener("exit", exited)
            reject(new Error("Test process shutdown timed out"))
        }, commandTimeout)
        const exited = () => {
            clearTimeout(timeout)
            resolve()
        }
        child.once("exit", exited)
        child.kill("SIGKILL")
    })
}

export class Chromium {
    private readonly pages: BrowserPage[] = []

    private constructor(
        private readonly process: ChildProcess,
        private readonly endpoint: string,
    ) {}

    static async launch(profile: string): Promise<Chromium> {
        const browser = spawn(chromiumPath, [
            "--headless",
            "--no-sandbox",
            "--disable-gpu",
            "--ignore-certificate-errors",
            "--remote-debugging-port=0",
            `--user-data-dir=${profile}`,
            "about:blank",
        ])
        try {
            const endpoint = await new Promise<string>((resolve, reject) => {
                let log = ""
                const timeout = setTimeout(
                    () => finish(new Error(`Chromium startup timed out: ${log.slice(-2000)}`)),
                    20000,
                )
                const read = (data: Buffer) => {
                    log = (log + String(data)).slice(-4000)
                    const match = log.match(/DevTools listening on (ws:\/\/[^\s]+)/)
                    if (match) finish(undefined, new URL(match[1]).origin.replace("ws:", "http:"))
                }
                const exited = () => finish(new Error("Chromium exited before connecting"))
                const failed = (error: Error) => finish(error)
                const finish = (error?: Error, endpoint?: string) => {
                    clearTimeout(timeout)
                    browser.stderr!.removeListener("data", read)
                    browser.removeListener("exit", exited)
                    browser.removeListener("error", failed)
                    if (error) reject(error)
                    else resolve(endpoint!)
                }
                browser.stderr!.on("data", read)
                browser.once("error", failed)
                browser.once("exit", exited)
            })
            // Drain Chromium diagnostics without retaining an unbounded log.
            browser.stderr!.resume()
            browser.stdout!.resume()
            return new Chromium(browser, endpoint)
        } catch (error) {
            await terminate(browser)
            throw error
        }
    }

    private async request(path: string, method = "GET") {
        const response = await fetch(`${this.endpoint}${path}`, {
            method,
            signal: AbortSignal.timeout(commandTimeout),
        })
        if (!response.ok) throw new Error(`Chromium request failed: ${response.status} ${path}`)
        return response
    }

    async page(): Promise<BrowserPage> {
        const target = (await (await this.request("/json/new?about:blank", "PUT")).json()) as {
            id: string
            webSocketDebuggerUrl: string
        }
        try {
            const page = await BrowserPage.connect(target.webSocketDebuggerUrl, target.id)
            this.pages.push(page)
            return page
        } catch (error) {
            await this.closeTarget(target.id).catch(() => undefined)
            throw error
        }
    }

    async closeTarget(targetId: string) {
        await (await this.request(`/json/close/${targetId}`)).text()
    }

    async close() {
        for (const page of this.pages) page.close()
        await terminate(this.process)
    }
}
