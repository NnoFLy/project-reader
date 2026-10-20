import { describe, expect, it } from "vitest"
import { existsSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve, join } from "node:path"
import { createServer } from "vite"
import { svelte } from "@sveltejs/vite-plugin-svelte"
import type { AppExtension, ExtensionStorage } from "$lib/extension-api"
import { ExtensionHost } from "$lib/extension-host"
import { MemoryStorageBackend } from "$lib/core/storage"
import { Chromium, chromiumPath } from "../helpers/chromium"

function persistenceExtension(activate: (storage: ExtensionStorage) => void): AppExtension {
    return {
        manifest: {
            id: "test.persistence",
            name: "Writer persistence",
            version: "1.0.0",
            engine: "*",
            entry: "test.persistence",
            activationEvents: [{ type: "startup" }],
            permissions: ["storage"],
        },
        activate: (context) => activate(context.storage),
    }
}

// Supporting browser/host seam: exercise the production backend against native IndexedDB.
async function inBrowser(script: string): Promise<void> {
    const profile = await mkdtemp(join(tmpdir(), "reader-writer-persistence-"))
    let server: Awaited<ReturnType<typeof createServer>> | undefined
    let browser: Chromium | undefined
    try {
        server = await createServer({
            configFile: false,
            cacheDir: join(profile, "vite-cache"),
            plugins: [svelte({ configFile: false })],
            resolve: { alias: { $lib: resolve("src/lib") } },
            server: { port: 0, host: "127.0.0.1" },
            appType: "custom",
            logLevel: "error",
        })
        server.middlewares.use("/__writer-persistence", (_request, response) => {
            response.setHeader("Content-Type", "text/html")
            response.end(`<body><pre id="result">pending</pre><script type="module">
            import { IndexedDBStorageBackend, IndexedDBWriteLifetime, MemoryStorageBackend, createExtensionStorage } from "/src/lib/core/storage/memory.ts";
            import { migrateLegacyDatabaseToLibrary } from "/src/lib/core/legacy-migration.ts";
            import { ExtensionHost } from "/src/lib/extension-host/host.ts";
            const assert = (condition, message) => { if (!condition) throw new Error(message) };
            const rejected = async (promise) => {
                try { await promise } catch { return }
                throw new Error("Obsolete writer mutation succeeded");
            };
            try {
                ${script}
                document.querySelector("#result").textContent = "passed";
            } catch (error) {
                document.querySelector("#result").textContent = error.stack ?? String(error);
            }
        </script></body>`)
        })
        await server.listen()
        const address = server.httpServer!.address()
        if (!address || typeof address === "string") throw new Error("Missing browser test server")
        browser = await Chromium.launch(profile)
        const page = await browser.page()
        await page.call("Log.enable", {})
        await page.call("Page.navigate", {
            url: `http://127.0.0.1:${address.port}/__writer-persistence`,
        })
        let result = "pending"
        for (let attempt = 0; attempt < 200 && result === "pending"; attempt++) {
            await new Promise((resolve) => setTimeout(resolve, 50))
            const value = await page.evaluate(
                'document.querySelector("#result")?.textContent ?? "pending"',
            )
            if (typeof value === "string") result = value
        }
        expect({ result, browserErrors: page.errors }).toEqual({
            result: "passed",
            browserErrors: [],
        })
    } finally {
        try {
            await browser?.close()
        } finally {
            try {
                await server?.close()
            } finally {
                await rm(profile, { recursive: true, force: true })
            }
        }
    }
}

describe("host writer persistence", () => {
    it("uses the host write lifetime for its default storage", async () => {
        const controller = new AbortController()
        let storage!: ExtensionStorage
        const host = new ExtensionHost({
            extensions: [persistenceExtension((value) => (storage = value))],
            hostContext: { writeSignal: controller.signal },
        })
        await host.start()
        try {
            await storage.set("saved", "original")
            controller.abort()
            await expect(storage.set("saved", "obsolete")).rejects.toThrow()
            await expect(storage.delete("saved")).rejects.toThrow()
            await expect(storage.get("saved")).resolves.toBe("original")
        } finally {
            await host.dispose()
        }
    })

    it.skipIf(!existsSync(chromiumPath))(
        "rejects a host save revoked while its IndexedDB open completes",
        async () => {
            await inBrowser(`
                const controller = new AbortController();
                const nativeOpen = indexedDB.open.bind(indexedDB);
                const factory = new Proxy(indexedDB, {
                    get(target, key) {
                        if (key === "open") return (...args) => {
                            const request = nativeOpen(...args);
                            request.addEventListener("success", () => controller.abort(), {once: true});
                            return request;
                        };
                        const value = Reflect.get(target, key);
                        return typeof value === "function" ? value.bind(target) : value;
                    }
                });
                const backend = new IndexedDBStorageBackend({indexedDB: factory, signal: controller.signal});
                let storage;
                const host = new ExtensionHost({storage: backend, extensions: [{
                    manifest: {id: "test.persistence", name: "Persistence", version: "1.0.0", engine: "*",
                        entry: "test.persistence", activationEvents: [{type: "startup"}], permissions: ["storage"]},
                    activate(context) { storage = context.storage; }
                }]});
                await host.start();
                await rejected(storage.set("saved", "obsolete"));
                await backend.whenQuiescent();
                const observer = new IndexedDBStorageBackend();
                assert((await observer.keys()).length === 0, "Late save reached IndexedDB");
                await host.dispose();
            `)
        },
        40000,
    )
    it.skipIf(!existsSync(chromiumPath))(
        "aborts active host writes synchronously and waits for physical transaction termination",
        async () => {
            await inBrowser(`
                const seed = new IndexedDBStorageBackend();
                await seed.set("extension:test.persistence:saved", "original");
                const controller = new AbortController();
                let terminal = false;
                let synchronousAbort = false;
                const nativeOpen = indexedDB.open.bind(indexedDB);
                const factory = new Proxy(indexedDB, {
                    get(target, key) {
                        if (key === "open") return (...args) => {
                            const request = nativeOpen(...args);
                            request.addEventListener("success", () => {
                                const database = request.result;
                                const nativeTransaction = database.transaction.bind(database);
                                database.transaction = (...args) => {
                                    const transaction = nativeTransaction(...args);
                                    if (args[1] === "readwrite") {
                                        let abortCalled = false;
                                        const nativeAbort = transaction.abort.bind(transaction);
                                        transaction.abort = () => { abortCalled = true; nativeAbort(); };
                                        transaction.addEventListener("abort", () => { terminal = true; });
                                        queueMicrotask(() => {
                                            controller.abort();
                                            synchronousAbort = abortCalled;
                                        });
                                    }
                                    return transaction;
                                };
                            }, {once: true});
                            return request;
                        };
                        const value = Reflect.get(target, key);
                        return typeof value === "function" ? value.bind(target) : value;
                    }
                });
                const backend = new IndexedDBStorageBackend({indexedDB: factory, signal: controller.signal});
                let storage;
                const host = new ExtensionHost({storage: backend, extensions: [{
                    manifest: {id: "test.persistence", name: "Persistence", version: "1.0.0", engine: "*",
                        entry: "test.persistence", activationEvents: [{type: "startup"}], permissions: ["storage"]},
                    activate(context) { storage = context.storage; }
                }]});
                await host.start();
                await rejected(storage.set("saved", "obsolete"));
                await backend.whenQuiescent();
                assert(synchronousAbort, "Revocation did not synchronously abort the transaction");
                assert(terminal, "Quiescence preceded the native abort event");
                await rejected(storage.delete("saved"));
                assert(await seed.get("extension:test.persistence:saved") === "original", "Aborted save/delete changed data");
                await host.dispose();
            `)
        },
        40000,
    )

    it.skipIf(!existsSync(chromiumPath))(
        "fences a delayed legacy schema upgrade without purging or migrating source records",
        async () => {
            await inBrowser(`
                const initial = indexedDB.open("Database", 10);
                initial.onupgradeneeded = () => {
                    for (const name of ["books", "previews", "folders"]) initial.result.createObjectStore(name, {keyPath: "id"});
                    initial.transaction.objectStore("books").put({id: "book", name: "Existing Library", file: new Blob(["source"])});
                };
                const blocker = await new Promise((resolve, reject) => {
                    initial.onsuccess = () => resolve(initial.result);
                    initial.onerror = () => reject(initial.error);
                });
                const controller = new AbortController();
                const lifetime = new IndexedDBWriteLifetime(controller.signal);
                let prematureQuiescence = false;
                blocker.onversionchange = () => {
                    controller.abort();
                    let settled = false;
                    lifetime.whenQuiescent().then(() => { settled = true; });
                    setTimeout(() => {
                        prematureQuiescence = settled;
                        blocker.close();
                    }, 25);
                };
                const storage = createExtensionStorage(new MemoryStorageBackend(), "test.migration");
                await rejected(migrateLegacyDatabaseToLibrary(storage, undefined, {lifetime}));
                await lifetime.whenQuiescent();
                assert(!prematureQuiescence, "Pending native schema open was not included in quiescence");
                const inspection = indexedDB.open("Database");
                const source = await new Promise((resolve, reject) => {
                    inspection.onsuccess = () => resolve(inspection.result);
                    inspection.onerror = () => reject(inspection.error);
                });
                assert(source.version === 10, "Obsolete owner upgraded the legacy schema");
                const record = await new Promise((resolve) => {
                    source.transaction("books").objectStore("books").get("book").onsuccess = (event) => resolve(event.target.result);
                });
                assert(record.name === "Existing Library" && await record.file.text() === "source", "Source Library record changed");
                source.close();
            `)
        },
        40000,
    )

    it("fences saves and deletes queued by an obsolete host while preserving saved records", async () => {
        const controller = new AbortController()
        const backend = new MemoryStorageBackend({ signal: controller.signal })
        let storage!: ExtensionStorage
        const host = new ExtensionHost({
            extensions: [persistenceExtension((value) => (storage = value))],
            storage: backend,
            hostContext: { writeSignal: controller.signal },
        })
        await host.start()
        try {
            await storage.set("saved", "original")
            const lateSave = storage.set("saved", "obsolete")
            const lateDelete = storage.delete("saved")
            controller.abort()
            await expect(lateSave).rejects.toThrow()
            await expect(lateDelete).rejects.toThrow()
            await expect(storage.set("late", true)).rejects.toThrow()
            await expect(storage.get("saved")).resolves.toBe("original")
            await backend.whenQuiescent()
        } finally {
            await host.dispose()
        }
    })
})
