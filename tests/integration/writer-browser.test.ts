import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { spawn, type ChildProcess } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { Chromium, chromiumPath, terminate } from "../helpers/chromium"

// These pages share one browser profile, origin and real IndexedDB Library.
// A native lock and a renderer crash cannot be established by jsdom/storage stand-ins.
describe.skipIf(!existsSync(chromiumPath))("same-origin Library writer windows", () => {
    let profile: string
    let browser: Chromium | undefined
    let server: ChildProcess | undefined
    let origin: string

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
                    const { realpathSync } = await import('node:fs');
                    const server = await createServer({
                        cacheDir: ${JSON.stringify(join(profile, "vite-cache"))},
                        server: {host: '127.0.0.1', port: 0, fs: {allow: [process.cwd(), realpathSync('node_modules')]}}
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
        browser = await Chromium.launch(profile)
    }, 70000)

    afterAll(async () => {
        try {
            await browser?.close()
        } finally {
            try {
                await terminate(server)
            } finally {
                if (profile) await rm(profile, { recursive: true, force: true })
            }
        }
    })

    async function page() {
        return browser!.page()
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
            first.call("Page.navigate", { url: `${origin}/en` }),
            second.call("Page.navigate", { url: `${origin}/en` }),
        ])
        await Promise.all([first.waitFor(settled), second.waitFor(settled)])
        const firstOwns = await first.evaluate(ready)
        const owner = firstOwns ? first : second
        const contender = firstOwns ? second : first
        const ownerTarget = owner.targetId
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

        await browser!.closeTarget(ownerTarget)
        await contender.waitFor(
            "navigator.locks.query().then(result => result.held.every(lock => !lock.name.endsWith(':writer')))",
        )
        await contender.evaluate(retry)
        await contender.waitFor(ready)
        expect(await contender.evaluate(records)).toEqual(preserved)

        const recovery = await page()
        await recovery.call("Page.navigate", { url: `${origin}/en` })
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
        await old.call("Page.navigate", { url: `${origin}/en` })
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
        await next.call("Page.navigate", { url: `${origin}/en` })
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
        await unsupported.call("Page.navigate", { url: `${origin}/en/viewer` })
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

        await unsupported.call("Page.navigate", { url: `${origin}/viewer` })
        await unsupported.waitFor("!!document.querySelector('[data-writer-state=unsupported]')")
        await unsupported.call("Emulation.setDeviceMetricsOverride", {
            width: 320,
            height: 568,
            deviceScaleFactor: 1,
            mobile: true,
        })
        expect(await unsupported.evaluate("document.querySelector('h1')?.textContent")).toBe(
            "Этот браузер не может безопасно открыть библиотеку",
        )
        expect(
            await unsupported.evaluate(
                "Array.from(document.querySelectorAll('button'), button => button.textContent.trim())",
            ),
        ).toEqual(["Повторить попытку", "Перезагрузить страницу"])
        expect(
            await unsupported.evaluate("document.documentElement.scrollWidth <= innerWidth"),
        ).toBe(true)
    }, 45000)
})
