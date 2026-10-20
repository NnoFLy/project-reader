import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { spawn, type ChildProcess } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const chromium = process.env.CHROMIUM_PATH ?? "/usr/sbin/chromium"
type Reply = { result?: { value?: unknown }; exceptionDetails?: unknown }

class BrowserPage {
    private sequence = 0
    private errors: unknown[] = []
    private pending = new Map<
        number,
        { resolve: (value: Reply) => void; reject: (error: Error) => void }
    >()

    private constructor(private readonly socket: WebSocket) {
        socket.addEventListener("message", (event) => {
            const message = JSON.parse(String(event.data))
            if (message.method === "Runtime.exceptionThrown")
                this.errors.push(message.params.exceptionDetails)
            const pending = this.pending.get(message.id)
            if (!pending) return
            this.pending.delete(message.id)
            if (message.error) pending.reject(new Error(message.error.message))
            else pending.resolve(message.result)
        })
        socket.addEventListener("close", () => {
            for (const pending of this.pending.values())
                pending.reject(new Error("Browser page closed"))
            this.pending.clear()
        })
    }

    static async connect(endpoint: string): Promise<BrowserPage> {
        const socket = new WebSocket(endpoint)
        await new Promise<void>((resolve, reject) => {
            socket.addEventListener("open", () => resolve(), { once: true })
            socket.addEventListener("error", () => reject(new Error("Browser connection failed")), {
                once: true,
            })
        })
        const page = new BrowserPage(socket)
        await page.call("Page.enable")
        await page.call("Runtime.enable")
        return page
    }

    call(method: string, params: Record<string, unknown> = {}): Promise<Reply> {
        return new Promise((resolve, reject) => {
            const id = ++this.sequence
            const timeout = setTimeout(() => {
                this.pending.delete(id)
                reject(new Error(`Browser command timed out: ${method}`))
            }, 10000)
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
            this.socket.send(JSON.stringify({ id, method, params }))
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

    close() {
        this.socket.close()
    }
}

async function terminate(child: ChildProcess | undefined) {
    if (!child || child.exitCode !== null || child.signalCode !== null) return
    const exited = new Promise((resolve) => child.once("exit", resolve))
    child.kill("SIGKILL")
    await exited
}

// These pages share one browser profile, origin and real IndexedDB Library.
// A native lock and a renderer crash cannot be established by jsdom/storage stand-ins.
describe.skipIf(!existsSync(chromium))("same-origin Library writer windows", () => {
    let profile: string
    let browser: ChildProcess | undefined
    let server: ChildProcess | undefined
    let endpoint: string
    let origin: string
    const pages: BrowserPage[] = []
    const targets: string[] = []

    beforeAll(async () => {
        profile = await mkdtemp(join(tmpdir(), "reader-writer-windows-"))
        origin = process.env.WRITER_TEST_URL ?? ""
        if (!origin) {
            server = spawn(
                process.execPath,
                [
                    "--input-type=module",
                    "--eval",
                    `
                    const { createServer } = await import('vite');
                    const server = await createServer({
                        cacheDir: ${JSON.stringify(join(profile, "vite-cache"))},
                        server: {host: '127.0.0.1', port: 0}
                    });
                    await server.listen();
                    server.printUrls();
                `,
                ],
                { env: { ...process.env, VITEST: "", NO_COLOR: "1" } },
            )
            origin = await new Promise<string>((resolve, reject) => {
                let log = ""
                const timeout = setTimeout(
                    () => reject(new Error(`Test server startup timed out: ${log.slice(-2000)}`)),
                    40000,
                )
                const read = (data: Buffer) => {
                    log += String(data)
                    const match = log.match(/https:\/\/127\.0\.0\.1:\d+/)
                    if (match) {
                        clearTimeout(timeout)
                        resolve(match[0])
                    }
                }
                server!.stdout!.on("data", read)
                server!.stderr!.on("data", read)
                server!.once("error", reject)
                server!.once("exit", () => {
                    clearTimeout(timeout)
                    reject(new Error(`Test server exited: ${log.slice(-2000)}`))
                })
            })
        }
        browser = spawn(chromium, [
            "--headless",
            "--no-sandbox",
            "--disable-gpu",
            "--ignore-certificate-errors",
            "--remote-debugging-port=0",
            `--user-data-dir=${profile}`,
            "about:blank",
        ])
        endpoint = await new Promise<string>((resolve, reject) => {
            let log = ""
            const timeout = setTimeout(() => reject(new Error("Chromium startup timed out")), 20000)
            browser!.stderr!.on("data", (data) => {
                log += String(data)
                const match = log.match(/DevTools listening on (ws:\/\/[^\s]+)/)
                if (match) {
                    clearTimeout(timeout)
                    resolve(new URL(match[1]).origin.replace("ws:", "http:"))
                }
            })
            browser!.once("error", reject)
            browser!.once("exit", () => {
                clearTimeout(timeout)
                reject(new Error("Chromium exited before connecting"))
            })
        })
    }, 70000)

    afterAll(async () => {
        for (const page of pages) page.close()
        await terminate(browser)
        await terminate(server)
        if (profile) await rm(profile, { recursive: true, force: true })
    })

    async function page() {
        const target = (await (
            await fetch(`${endpoint}/json/new?about:blank`, { method: "PUT" })
        ).json()) as { id: string; webSocketDebuggerUrl: string }
        targets.push(target.id)
        const page = await BrowserPage.connect(target.webSocketDebuggerUrl)
        pages.push(page)
        return page
    }

    const ready = "!!document.querySelector('#app-root')"
    const blocked = "!!document.querySelector('[data-writer-state=blocked]')"
    const settled = `(${ready}) || (${blocked})`
    const retry =
        "Array.from(document.querySelectorAll('button')).find(button => button.textContent.trim() === 'Try again').click()"
    const records = `new Promise((resolve, reject) => {
        const request = indexedDB.open('vfs-extension-storage', 1);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
            const database = request.result;
            const transaction = database.transaction('values');
            const read = transaction.objectStore('values').getAll();
            read.onsuccess = async () => resolve(await Promise.all(read.result.filter(record => record.key.includes('writer-preservation')).map(async record => ({key: record.key, value: record.value.file instanceof Blob ? {id: record.value.id, file: await record.value.file.text()} : record.value}))));
            transaction.oncomplete = () => database.close();
        };
    })`

    it("excludes simultaneous writers, recovers on closure/crash, and preserves Library data", async () => {
        const first = await page()
        const second = await page()
        await Promise.all([
            first.call("Page.navigate", { url: origin }),
            second.call("Page.navigate", { url: origin }),
        ])
        await Promise.all([first.waitFor(settled), second.waitFor(settled)])
        const firstOwns = await first.evaluate(ready)
        const owner = firstOwns ? first : second
        const contender = firstOwns ? second : first
        const ownerTarget = targets[firstOwns ? 0 : 1]
        expect(await owner.evaluate(ready)).toBe(true)
        expect(await contender.evaluate(blocked)).toBe(true)
        expect(await contender.evaluate("document.querySelector('h1')?.textContent")).toBe(
            "Library is open in another window",
        )
        expect(
            await contender.evaluate(
                "document.querySelectorAll('input, textarea, #app-root').length",
            ),
        ).toBe(0)
        expect(
            await contender.evaluate(
                "navigator.locks.query().then(result => result.held.filter(lock => lock.name.endsWith(':writer')).length)",
            ),
        ).toBe(1)

        // Preserve an actual file Blob and unsupported reading record across every handover.
        await owner.evaluate(`new Promise((resolve, reject) => {
            const request = indexedDB.open('vfs-extension-storage', 1);
            request.onsuccess = () => {
                const database = request.result;
                const transaction = database.transaction('values', 'readwrite');
                const values = transaction.objectStore('values');
                values.put({key: 'extension:builtin.library:library:fileContents.writer-preservation', value: {id: 'writer-preservation', file: new Blob(['existing Library file'])}});
                values.put({key: 'extension:builtin.viewer:viewer:writer-preservation-old-record', value: {unsupported: 'preserve me'}});
                transaction.oncomplete = () => {database.close(); resolve(true)};
                transaction.onabort = () => reject(transaction.error);
            };
        })`)
        const preserved = await owner.evaluate(records)
        expect(preserved).toEqual([
            {
                key: "extension:builtin.library:library:fileContents.writer-preservation",
                value: { id: "writer-preservation", file: "existing Library file" },
            },
            {
                key: "extension:builtin.viewer:viewer:writer-preservation-old-record",
                value: { unsupported: "preserve me" },
            },
        ])

        await contender.call("Emulation.setDeviceMetricsOverride", {
            width: 320,
            height: 568,
            deviceScaleFactor: 1,
            mobile: true,
        })
        expect(await contender.evaluate("document.documentElement.scrollWidth <= innerWidth")).toBe(
            true,
        )
        await contender.call("Input.dispatchKeyEvent", {
            type: "keyDown",
            key: "Tab",
            code: "Tab",
            windowsVirtualKeyCode: 9,
        })
        await contender.call("Input.dispatchKeyEvent", {
            type: "keyUp",
            key: "Tab",
            code: "Tab",
            windowsVirtualKeyCode: 9,
        })
        expect(await contender.evaluate("document.activeElement?.textContent?.trim()")).toBe(
            "Try again",
        )
        await contender.call("Input.dispatchKeyEvent", {
            type: "keyDown",
            key: "Enter",
            code: "Enter",
            windowsVirtualKeyCode: 13,
        })
        await contender.call("Input.dispatchKeyEvent", {
            type: "keyUp",
            key: "Enter",
            code: "Enter",
            windowsVirtualKeyCode: 13,
        })
        await contender.waitFor(blocked)
        expect(await contender.evaluate("document.activeElement?.textContent?.trim()")).toBe(
            "Try again",
        )
        expect(await contender.evaluate(records)).toEqual(preserved)

        await fetch(`${endpoint}/json/close/${ownerTarget}`)
        await contender.waitFor(
            "navigator.locks.query().then(result => result.held.every(lock => !lock.name.endsWith(':writer')))",
        )
        await contender.evaluate(retry)
        await contender.waitFor(ready)
        expect(await contender.evaluate(records)).toEqual(preserved)

        const recovery = await page()
        await recovery.call("Page.navigate", { url: origin })
        await recovery.waitFor(blocked)
        // Page.crash terminates the owning renderer, not an orderly page.close.
        await contender.call("Page.crash").catch(() => undefined)
        await recovery.waitFor(
            "navigator.locks.query().then(result => result.held.every(lock => !lock.name.endsWith(':writer')))",
        )
        await recovery.evaluate(retry)
        await recovery.waitFor(ready)
        expect(await recovery.evaluate(records)).toEqual(preserved)
        expect(
            await recovery.evaluate(
                "navigator.locks.query().then(result => result.held.filter(lock => lock.name.endsWith(':writer')).length)",
            ),
        ).toBe(1)

        // Reload reacquires a fresh lifetime rather than restoring revoked capabilities.
        const previousDocument = await recovery.evaluate("performance.timeOrigin")
        await recovery.call("Page.reload")
        await recovery.waitFor(`${ready} && performance.timeOrigin !== ${previousDocument}`)
        expect(await recovery.evaluate(records)).toEqual(preserved)
        expect(
            await recovery.evaluate(
                "navigator.locks.query().then(result => result.held.filter(lock => lock.name.endsWith(':writer')).length)",
            ),
        ).toBe(1)

        // Actual back/forward navigation must not revive an obsolete writer (including BFCache).
        await recovery.call("Page.navigate", { url: "about:blank" })
        await recovery.waitFor("location.href === 'about:blank'")
        await recovery.evaluate("history.back()")
        await recovery.waitFor(ready)
        expect(await recovery.evaluate(records)).toEqual(preserved)
        await recovery.call("Page.navigate", { url: "about:blank" })
    }, 120000)

    it("fences an old owner's delayed save after another window acquires the Library", async () => {
        const old = await page()
        await old.call("Page.navigate", { url: origin })
        await old.waitFor(ready)
        await old.evaluate("window.dispatchEvent(new PageTransitionEvent('pagehide'))")
        await old.waitFor(
            "navigator.locks.query().then(result => result.held.every(lock => !lock.name.endsWith(':writer')))",
        )
        await old.evaluate(`(async () => {
            const {createBrowserApplication} = await import('/src/lib/app/bootstrap.ts');
            const {IndexedDBStorageBackend, createExtensionStorage} = await import('/src/lib/core/storage/index.ts');
            let backend;
            window.testWriter = createBrowserApplication({storage: lifetime => backend = new IndexedDBStorageBackend({lifetime})});
            await window.testWriter.start();
            if (!window.testWriter.ready) throw new Error('Test writer did not acquire the Library');
            const read = backend.get.bind(backend);
            backend.get = async key => {
                if (key.endsWith('writer-handover:__storage_meta:migration-journal')) await new Promise(resolve => window.finishOldRead = resolve);
                return read(key);
            };
            const storage = createExtensionStorage(backend, 'builtin.viewer').namespace('writer-handover');
            window.oldSave = storage.set('late', 'obsolete owner').then(() => 'incorrectly saved', () => 'rejected');
        })()`)
        await old.waitFor("typeof window.finishOldRead === 'function'")
        const next = await page()
        await next.call("Page.navigate", { url: origin })
        await next.waitFor(blocked)
        await old.evaluate("window.testWriter.stop()")
        await next.waitFor(
            "navigator.locks.query().then(result => result.held.every(lock => !lock.name.endsWith(':writer')))",
        )
        await next.evaluate(retry)
        await next.waitFor(ready)
        await old.evaluate("window.finishOldRead()")
        expect(await old.evaluate("window.oldSave")).toBe("rejected")
        expect(
            await next.evaluate(`(async () => {
            const {IndexedDBStorageBackend} = await import('/src/lib/core/storage/index.ts');
            return (await new IndexedDBStorageBackend().get('extension:builtin.viewer:writer-handover:late')) === undefined;
        })()`),
        ).toBe(true)
        await next.call("Page.navigate", { url: "about:blank" })
    }, 60000)

    it("fails closed without Web Locks, including direct Viewer navigation", async () => {
        const unsupported = await page()
        await unsupported.call("Page.addScriptToEvaluateOnNewDocument", {
            source: "Object.defineProperty(navigator, 'locks', {value: undefined, configurable: true}); localStorage.setItem('search_history', 'unsupported old history');",
        })
        await unsupported.call("Page.navigate", { url: `${origin}/viewer` })
        await unsupported.waitFor("!!document.querySelector('[data-writer-state=unsupported]')")
        expect(await unsupported.evaluate("document.querySelector('#app-root') === null")).toBe(
            true,
        )
        expect(await unsupported.evaluate("document.querySelector('h1')?.textContent")).toBe(
            "This browser cannot safely open the Library",
        )
        await unsupported.evaluate(retry)
        await unsupported.waitFor("!!document.querySelector('[data-writer-state=unsupported]')")
        expect(await unsupported.evaluate("localStorage.getItem('search_history')")).toBe(
            "unsupported old history",
        )
        expect(
            await unsupported.evaluate(
                "document.querySelectorAll('input, textarea, #app-root').length",
            ),
        ).toBe(0)
    }, 45000)
})
