import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { spawn, type ChildProcess } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { Chromium, chromiumPath, terminate, type BrowserPage } from "../helpers/chromium"

// Native Chromium, one disposable profile, the real host and its real IndexedDB backend.
// Missing Chromium is a failure, not a silently skipped persistence verification.
describe("Reading workspace browser persistence", () => {
    let profile: string
    let browser: Chromium | undefined
    let server: ChildProcess | undefined
    let origin: string

    beforeAll(async () => {
        expect(existsSync(chromiumPath), `Chromium required at ${chromiumPath}`).toBe(true)
        profile = await mkdtemp(join(tmpdir(), "reader-reading-persistence-"))
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
                log = (log + String(data)).slice(-4000)
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
                reject(new Error(`Test server exited: ${log}`))
            })
        })
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

    const ready = "!!document.querySelector('#app-root')"
    const bindings = `(async () => {
        window.reader = (await import('/src/lib/extensions/builtin/viewer/stores/viewerStore.svelte.ts')).viewerStore;
        window.notes = (await import('/src/lib/extensions/builtin/viewer/stores/notesStore.svelte.ts')).notesStore;
        window.bookmarks = (await import('/src/lib/extensions/builtin/viewer/stores/bookmarksStore.svelte.ts')).bookmarksStore;
        window.ui = (await import('/src/lib/core/commands/index.ts')).commandsStore;
        window.library = (await import('/src/lib/extensions/builtin/library/state/libraryStore.svelte.ts')).libraryStore;
        window.command = (await import('/src/lib/extensions/builtin/viewer/viewerHost.ts')).executeViewerCommand;
        return true;
    })()`
    const snapshot = "window.reader.workspace.snapshot"
    const records = `new Promise((resolve, reject) => {
        const request = indexedDB.open('vfs-extension-storage', 1);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
            const database = request.result;
            const transaction = database.transaction('values');
            const read = transaction.objectStore('values').getAll();
            read.onsuccess = () => resolve(read.result.filter(record => record.key.includes(':reading-v1-')));
            transaction.onabort = () => reject(transaction.error);
            transaction.oncomplete = () => database.close();
        };
    })`

    // A small valid eight-page PDF: actual PDF.js parsing/rendering, no format adapter stand-in.
    const pdf = (() => {
        const objects = [
            "<< /Type /Catalog /Pages 2 0 R >>",
            "<< /Type /Pages /Kids [3 0 R 4 0 R 5 0 R 6 0 R 7 0 R 8 0 R 9 0 R 10 0 R] /Count 8 >>",
        ]
        for (let page = 0; page < 8; page++)
            objects.push(
                "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /Resources << /Font << /F1 12 0 R >> >> /Contents 11 0 R >>",
            )
        const passage = "BT /F1 14 Tf 30 300 Td (Reading passage) Tj ET\n"
        objects.push(`<< /Length ${passage.length} >>\nstream\n${passage}endstream`)
        objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")
        let text = "%PDF-1.4\n"
        const offsets = [0]
        for (const [index, object] of objects.entries()) {
            offsets.push(text.length)
            text += `${index + 1} 0 obj\n${object}\nendobj\n`
        }
        const xref = text.length
        text += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
        text += offsets
            .slice(1)
            .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
            .join("")
        return `${text}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`
    })()

    async function bind(page: BrowserPage) {
        await page.waitFor(ready)
        await page.evaluate(bindings)
    }

    // Trusted composition: suspend the shell, wait for the native writer lock, then
    // mount the real static route against a real, gated WriterApplication.
    async function mountProviderRoute(page: BrowserPage) {
        await page.evaluate("window.dispatchEvent(new PageTransitionEvent('pagehide'))")
        await page.waitFor(
            "navigator.locks.query().then(result => result.held.every(lock => !lock.name.endsWith(':writer')))",
        )
        await page.evaluate(`(async () => {
            const {createBrowserApplication} = await import('/src/lib/app/bootstrap.ts');
            const {IndexedDBStorageBackend} = await import('/src/lib/core/storage/index.ts');
            const {mountReadingProviderRoute} = await import('/tests/helpers/reading-provider-route.ts');
            const {APP_HOST_CONTEXT} = await import('/src/lib/app/hostContext.ts');
            window.writer = createBrowserApplication({storage: lifetime => window.backend = new IndexedDBStorageBackend({lifetime})});
            await window.writer.start();
            if (!window.writer.ready) throw new Error('Provider test writer unavailable');
            window.host = window.writer.application.host;
            const context = {
                get application() { return window.writer.application; },
                get ready() { return window.writer.ready; },
                services: {executeCommand: (id, payload) => window.writer.executeCommand(id, payload)}
            };
            const target = document.createElement('div');
            target.id = 'provider-test-route'; document.body.append(target);
            window.providerRoute = mountReadingProviderRoute(target, new Map([[APP_HOST_CONTEXT, context], ['app-host-services', context.services]]));
        })()`)
        await page.evaluate(bindings)
    }

    async function nativeRetry(page: BrowserPage, selector: string, key = "Enter") {
        await page.evaluate(`(() => {
            window.retryButton = document.querySelector(${JSON.stringify(selector)});
            window.retryButton.focus();
        })()`)
        const code = key === "Enter" ? "Enter" : "Space"
        const number = key === "Enter" ? 13 : 32
        await page.call("Input.dispatchKeyEvent", {
            type: "keyDown",
            key,
            code,
            windowsVirtualKeyCode: number,
            text: key === "Enter" ? "\r" : " ",
        })
        await page.call("Input.dispatchKeyEvent", {
            type: "keyUp",
            key,
            code,
            windowsVirtualKeyCode: number,
        })
    }

    it.each([1280, 390])(
        "warns, cancels and retries confirmed deletion with keyboard at %ipx",
        async (width) => {
            const page = await browser!.page()
            try {
                await page.call("Emulation.setDeviceMetricsOverride", {
                    width,
                    height: 844,
                    deviceScaleFactor: 1,
                    mobile: width < 500,
                })
                await page.call("Page.navigate", { url: `${origin}/en` })
                await bind(page)
                const id = await page.evaluate(`(async () => {
                    const [result] = await window.library.importFiles([{name:'delete-${width}.pdf', source:new File([${JSON.stringify(pdf)}], 'delete.pdf', {type:'application/pdf'})}], null);
                    await window.reader.workspace.open(result.id);
                    await window.reader.workspace.createDraft(result.id, {pageNumber:1,start:0,end:7,text:'passage',noteContent:'Private draft',color:'purple',association:{contentHash:null,verification:'unverified'}});
                    await window.reader.workspace.flush();
                    return result.id;
                })()`)
                await page.evaluate(
                    `window.command('library.node.delete', {nodeId:${JSON.stringify(id)}})`,
                )
                await page.waitFor("!!document.querySelector('[role=alertdialog]')")
                const warning = await page.evaluate(
                    "document.querySelector('[role=alertdialog]').textContent",
                )
                for (const label of ["progress", "bookmarks", "saved notes", "Note drafts"])
                    expect(warning).toContain(label)
                await nativeRetry(
                    page,
                    "[role=alertdialog] .confirmation-actions button:first-child",
                )
                await page.waitFor("!document.querySelector('[role=alertdialog]')")
                expect(await page.evaluate(`window.reader.workspace.snapshot.documentId`)).toBe(id)
                expect(
                    await page.evaluate(
                        `window.reader.workspace.annotations(${JSON.stringify(id)}).drafts.length`,
                    ),
                ).toBe(1)
                expect(await page.evaluate(`!!window.library.nodes[${JSON.stringify(id)}]`)).toBe(
                    true,
                )

                await page.evaluate(`(() => {
                    const remove = IDBObjectStore.prototype.delete;
                    window.restoreDelete = () => IDBObjectStore.prototype.delete = remove;
                    window.cleanupDeleteFailures = 0;
                    IDBObjectStore.prototype.delete = function(key) {
                        if (typeof key === 'string' && key.includes(':reading-v1-annotations-')) {
                            window.cleanupDeleteFailures++;
                            throw new DOMException('injected cleanup failure', 'UnknownError');
                        }
                        return remove.call(this, key);
                    };
                })()`)
                await page.evaluate(
                    `window.command('library.node.delete', {nodeId:${JSON.stringify(id)}})`,
                )
                await page.waitFor("!!document.querySelector('[role=alertdialog]')")
                await nativeRetry(
                    page,
                    "[role=alertdialog] .confirmation-actions button:last-child",
                )
                // Pending feedback starts at source commit, before Viewer cleanup runs.
                // Observe the injected failure and settled attempt, not just that early flag.
                await page.waitFor(
                    "window.cleanupDeleteFailures > 0 && !window.library.readingCleanupBusy && window.library.readingCleanupPending && !document.querySelector('[role=alertdialog]')",
                )
                expect(await page.evaluate("document.body.textContent")).toContain(
                    "Reading-data cleanup is incomplete",
                )
                expect(await page.evaluate("window.reader.workspace.snapshot.status")).toBe(
                    "deletion-pending",
                )
                expect(await page.evaluate(`!!window.library.nodes[${JSON.stringify(id)}]`)).toBe(
                    false,
                )
                await page.evaluate(`(() => {
                    const link = document.createElement('a');
                    link.id = 'deletion-reader-link'; link.href = '/en/viewer'; link.textContent = 'Reading recovery';
                    document.body.append(link);
                })()`)
                await nativeRetry(page, "#deletion-reader-link")
                await page.waitFor(
                    "!!document.querySelector('[data-reading-state=deletion-pending]')",
                )
                expect(
                    await page.evaluate(
                        "document.querySelector('[data-reading-state=deletion-pending]').textContent",
                    ),
                ).toContain("Private draft")
                expect(
                    await page.evaluate(
                        "document.querySelectorAll('textarea, .fullscreen-viewer').length",
                    ),
                ).toBe(0)
                await page.evaluate("window.restoreDelete()")
                await nativeRetry(page, "[data-reading-state=deletion-pending] button", " ")
                await page.waitFor(
                    "!window.library.readingCleanupPending && window.reader.workspace.snapshot.documentId === null",
                )
                expect(
                    await page.evaluate("document.querySelectorAll('.fullscreen-viewer').length"),
                ).toBe(0)
                expect(await page.evaluate("!!document.querySelector('.container')")).toBe(true)
                const before = await page.evaluate("performance.timeOrigin")
                await page.call("Page.reload")
                await page.waitFor(`${ready} && performance.timeOrigin !== ${before}`)
                await bind(page)
                expect(
                    await page.evaluate("window.reader.workspace.snapshot.documentId"),
                ).toBeNull()
                expect(
                    await page.evaluate(
                        `window.reader.workspace.createDraft(${JSON.stringify(id)}, {pageNumber:1,start:0,end:1,text:'x',noteContent:'late',color:'yellow',association:{contentHash:null,verification:'unverified'}}).then(result => result.ok)`,
                    ),
                ).toBe(false)
            } finally {
                await browser!.closeTarget(page.targetId)
            }
        },
        90000,
    )

    it("retains newer Reading recovery position over current history and still restores back and forward jumps", async () => {
        const page = await browser!.page()
        try {
            await page.call("Page.navigate", { url: `${origin}/en` })
            await bind(page)
            const id = await page.evaluate(`(async () => {
                const [result] = await window.library.importFiles([{name:'history-recovery.pdf', source:new File([${JSON.stringify(pdf)}], 'history-recovery.pdf', {type:'application/pdf'})}], null);
                return result.id;
            })()`)
            await mountProviderRoute(page)
            await page.evaluate(`window.reader.workspace.open(${JSON.stringify(id)})`)
            await page.waitFor("window.reader.activeTotalPages === 8")
            await page.evaluate(`(async () => {
                await window.command('settings.layout', {value:'single'});
                window.reader.goToPage(3, {scrollPosition:0.2});
                window.historyPage = (await import('/node_modules/@sveltejs/kit/src/runtime/app/state/index.js')).page;
            })()`)
            // Wait for the real debounced history write, then retire Viewer before the
            // newer position can replace that entry. No synthetic store/history mocks.
            await page.waitFor("window.historyPage.state.scrollPosition === 0.2")
            await page.evaluate(`(async () => {
                const {pushState} = await import('/node_modules/@sveltejs/kit/src/runtime/app/navigation.js');
                pushState('', {...window.historyPage.state});
                window.reader.workspace.setPosition(3, 0.25);
                await window.host.disable('builtin.viewer');
                await window.host.enable('builtin.viewer');
                await window.host.activate('builtin.viewer');
            })()`)
            await page.evaluate(bindings)
            expect(await page.evaluate(snapshot)).toMatchObject({
                documentId: id,
                status: "provider-unavailable",
                state: { pageNumber: 3, scrollPosition: 0.25 },
            })
            expect(await page.evaluate("window.historyPage.state.scrollPosition")).toBe(0.2)
            await nativeRetry(
                page,
                '[data-reading-state="provider-unavailable"] .reading-access-actions button',
            )
            await page.waitFor(
                "window.reader.activeTotalPages === 8 && !!document.querySelector('.fullscreen-viewer')",
            )
            expect(await page.evaluate(snapshot)).toMatchObject({
                documentId: id,
                status: "ready",
                state: { pageNumber: 3, scrollPosition: 0.25 },
            })
            // This distinct entry has the same values as the ignored recovery entry:
            // it is now an intentional traversal, not a replay caused by replacement.
            await page.evaluate("history.back()")
            await page.waitFor("window.reader.scrollPosition === 0.2")
            expect(await page.evaluate(snapshot)).toMatchObject({
                state: { pageNumber: 3, scrollPosition: 0.2 },
            })
            await page.evaluate("window.reader.goToPage(4, {scrollPosition:0.4, isJump:true})")
            await page.evaluate("window.reader.goToPage(5, {scrollPosition:0.6, isJump:true})")
            await page.evaluate("history.back()")
            await page.waitFor("window.reader.currentPage === 4")
            expect(await page.evaluate(snapshot)).toMatchObject({
                state: { pageNumber: 4, scrollPosition: 0.4 },
            })
            await page.evaluate("history.forward()")
            await page.waitFor("window.reader.currentPage === 5")
            expect(await page.evaluate(snapshot)).toMatchObject({
                state: { pageNumber: 5, scrollPosition: 0.6 },
            })
            await page.evaluate("window.writer.stop()")
        } finally {
            await browser!.closeTarget(page.targetId)
        }
    }, 90000)

    it.each([1280, 390])(
        "recovers PDF, Library and Viewer loss with keyboard retry, safe drafts and native writer exclusion at %ipx",
        async (width) => {
            const page = await browser!.page()
            let contender: BrowserPage | undefined
            try {
                await page.call("Emulation.setDeviceMetricsOverride", {
                    width,
                    height: 844,
                    deviceScaleFactor: 1,
                    mobile: width < 500,
                })
                await page.call("Page.navigate", { url: `${origin}/en` })
                await bind(page)
                const id = await page.evaluate(`(async () => {
                    const [result] = await window.library.importFiles([{name:'provider-recovery.pdf', source:new File([${JSON.stringify(pdf)}], 'provider-recovery.pdf', {type:'application/pdf'})}], null);
                    return result.id;
                })()`)
                await mountProviderRoute(page)
                await page.evaluate(`window.reader.workspace.open(${JSON.stringify(id)})`)
                await page.waitFor(
                    "window.reader.totalPages === 8 && document.querySelectorAll('.fullscreen-viewer').length === 1",
                )
                await page.evaluate(`(async () => {
                    await window.reader.workspace.loadDocument();
                    await window.command('settings.layout', {value:'single'});
                    await window.command('settings.zoom.in', {value:1.5});
                    window.reader.goToPage(3, {scrollPosition:0.2});
                    await window.notes.openDraft({bookId:${JSON.stringify(id)},pageNumber:3,start:0,end:7,text:'<img src=x onerror=alert(1)> passage',noteContent:'Recovered <img src=x> draft',color:'purple'});
                    await window.reader.workspace.flush();
                })()`)
                await page.waitFor(
                    "document.querySelector('textarea')?.value === 'Recovered <img src=x> draft'",
                )
                await page.evaluate(
                    "Array.from(document.querySelectorAll('button')).find(button => button.textContent.trim() === 'Got it')?.click()",
                )
                await nativeRetry(page, "[role=dialog]:has(textarea) [aria-label=Close]")
                await page.waitFor("!document.querySelector('textarea')")
                const retained = {
                    documentId: id,
                    state: { pageNumber: 3, scrollPosition: 0.2, scale: 1.5, layout: "single" },
                }
                for (const provider of ["builtin.pdf", "builtin.library", "builtin.viewer"]) {
                    if (provider === "builtin.viewer") {
                        // A real backend operation stays pending across disable. Host retry
                        // must fail closed until it drains, without replacing the button.
                        await page.evaluate(`(() => {
                            const set = window.backend.set.bind(window.backend);
                            let delayed = false;
                            window.backend.set = async (key, value) => {
                                if (!delayed && key.includes(':reading-v1-document-')) {
                                    delayed = true;
                                    await new Promise(resolve => window.releaseProviderWrite = resolve);
                                }
                                return set(key, value);
                            };
                            window.reader.workspace.setPosition(3, 0.25);
                        })()`)
                        await page.waitFor("typeof window.releaseProviderWrite === 'function'")
                        retained.state.scrollPosition = 0.25
                    }
                    await page.evaluate(`window.host.disable(${JSON.stringify(provider)})`)
                    const feedback =
                        provider === "builtin.viewer"
                            ? "[data-provider-feedback]"
                            : '[data-reading-state="provider-unavailable"]'
                    await page.waitFor(`!!document.querySelector(${JSON.stringify(feedback)})`)
                    expect(
                        await page.evaluate(
                            "document.querySelectorAll('.fullscreen-viewer').length",
                        ),
                    ).toBe(0)
                    expect(
                        await page.evaluate("window.host.documentService.openDocumentCount"),
                    ).toBe(0)
                    expect(
                        await page.evaluate(`(() => {
                        const region = document.querySelector(${JSON.stringify(feedback)});
                        const status = region.matches('[role=status]') ? region : region.querySelector('[role=status]');
                        return !!status && !!document.getElementById(status.getAttribute('aria-labelledby')) && !region.querySelector('img');
                    })()`),
                    ).toBe(true)
                    // Provider loss is not application shutdown: another same-origin page
                    // remains blocked even when no reader resource is mounted.
                    if (!contender) {
                        contender = await browser!.page()
                        await contender.call("Page.navigate", { url: `${origin}/en/viewer` })
                    }
                    await contender.waitFor(
                        "!!document.querySelector('[data-writer-state=blocked]')",
                    )
                    await nativeRetry(contender, "[data-writer-state=blocked] button")
                    await contender.waitFor(
                        "document.querySelector('[data-writer-state=blocked] button')?.getAttribute('aria-disabled') === 'false'",
                    )
                    expect(
                        await contender.evaluate(
                            "document.activeElement === window.retryButton && !document.querySelector('#app-root, .fullscreen-viewer, textarea')",
                        ),
                    ).toBe(true)
                    await page.call("Page.bringToFront")
                    const retrySelector =
                        provider === "builtin.viewer"
                            ? `${feedback} button`
                            : `${feedback} .reading-access-actions button`
                    await nativeRetry(page, retrySelector, " ")
                    await page.waitFor(
                        `document.querySelector(${JSON.stringify(retrySelector)})?.getAttribute('aria-disabled') === 'false'`,
                    )
                    expect(
                        await page.evaluate(`(() => {
                            const button = window.retryButton;
                            const rect = button.getBoundingClientRect();
                            return document.activeElement === button && button.isConnected
                                && rect.left >= 0 && rect.right <= innerWidth + 1 && rect.height >= 30;
                        })()`),
                    ).toBe(true)
                    expect(
                        await page.evaluate(
                            `window.host.providers.get(${JSON.stringify(provider)}).state`,
                        ),
                    ).toBe("disabled")
                    expect(
                        await page.evaluate(
                            "document.body.textContent.includes('ProviderRecoveryBlockedError') || document.body.textContent.includes('Error:')",
                        ),
                    ).toBe(false)
                    if (provider === "builtin.viewer") {
                        await page.evaluate("window.releaseProviderWrite()")
                        await page.evaluate("window.reader.workspace.flush()")
                        // Host-owned retry enables Viewer; Reading access still needs its
                        // own explicit retry, never an implicit document resurrection.
                        await nativeRetry(page, `${feedback} button`)
                        await page.waitFor(
                            "window.host.providers.get('builtin.viewer').state === 'active' && !!document.querySelector('[data-reading-state=provider-unavailable]')",
                        )
                        await page.evaluate(bindings)
                    } else {
                        await page.evaluate(
                            `(async () => {await window.host.enable(${JSON.stringify(provider)}); await window.host.activate(${JSON.stringify(provider)});})()`,
                        )
                    }
                    expect(await page.evaluate(snapshot)).toMatchObject({
                        ...retained,
                        status: "provider-unavailable",
                    })
                    await nativeRetry(
                        page,
                        '[data-reading-state="provider-unavailable"] .reading-access-actions button',
                    )
                    await page.waitFor(
                        "window.reader.totalPages === 8 && document.querySelectorAll('.fullscreen-viewer').length === 1",
                    )
                    expect(await page.evaluate(snapshot)).toMatchObject({
                        ...retained,
                        status: "ready",
                    })
                    expect(
                        await page.evaluate(
                            `window.reader.workspace.annotations(${JSON.stringify(id)}).drafts.map(draft => [draft.noteContent, draft.color])`,
                        ),
                    ).toEqual([["Recovered <img src=x> draft", "purple"]])
                    await page.evaluate(`(async () => {
                        await window.reader.workspace.loadDocument();
                        window.notes.showDraft(window.notes.drafts[0].id);
                    })()`)
                    await page.waitFor(
                        "document.querySelector('textarea')?.value === 'Recovered <img src=x> draft'",
                    )
                    expect(
                        await page.evaluate("!document.querySelector('[role=dialog] img')"),
                    ).toBe(true)
                    await nativeRetry(page, "[role=dialog]:has(textarea) [aria-label=Close]")
                    await page.waitFor("!document.querySelector('textarea')")
                    expect(
                        await page.evaluate(
                            "navigator.locks.query().then(result => result.held.filter(lock => lock.name.endsWith(':writer')).length)",
                        ),
                    ).toBe(1)
                }
                await page.evaluate("window.writer.stop()")
                await contender!.waitFor(
                    "navigator.locks.query().then(result => result.held.every(lock => !lock.name.endsWith(':writer')))",
                )
                await nativeRetry(contender!, "[data-writer-state=blocked] button")
                await bind(contender!)
                await contender!.waitFor(
                    "window.reader.totalPages === 8 && document.querySelectorAll('.fullscreen-viewer').length === 1",
                )
                expect(await contender!.evaluate(snapshot)).toMatchObject({
                    ...retained,
                    status: "ready",
                })
                expect(
                    await contender!.evaluate(
                        `window.reader.workspace.annotations(${JSON.stringify(id)}).drafts.map(draft => draft.noteContent)`,
                    ),
                ).toEqual(["Recovered <img src=x> draft"])
            } finally {
                await browser!.closeTarget(page.targetId)
                if (contender) await browser!.closeTarget(contender.targetId)
            }
        },
        120000,
    )

    it.each(["selection", "close"])(
        "does not resurrect a provider-recovery retry after a newer %s in Chromium",
        async (supersession) => {
            const page = await browser!.page()
            try {
                await page.call("Page.navigate", { url: `${origin}/en` })
                await bind(page)
                const ids = (await page.evaluate(`(async () => {
                    const results = await window.library.importFiles(['retry-old','retry-new'].map(name => ({name:name+'.pdf', source:new File([${JSON.stringify(pdf)}],name+'.pdf',{type:'application/pdf'})})),null);
                    return results.map(result => result.id);
                })()`)) as string[]
                await mountProviderRoute(page)
                await page.evaluate(`window.reader.workspace.open(${JSON.stringify(ids[0])})`)
                await page.waitFor(
                    "window.reader.totalPages === 8 && !!document.querySelector('.fullscreen-viewer')",
                )
                await page.evaluate(`(async () => {
                    await window.host.disable('builtin.library');
                    await window.host.enable('builtin.library');
                    await window.host.activate('builtin.library');
                    const get = window.backend.get.bind(window.backend);
                    let delayed = false;
                    window.backend.get = async key => {
                        if (!delayed && key.endsWith(':library:fileContents.' + ${JSON.stringify(ids[0])})) {
                            delayed = true;
                            await new Promise(resolve => window.releaseRetryRead = resolve);
                        }
                        return get(key);
                    };
                    window.retryResult = window.reader.workspace.retry();
                })()`)
                await page.waitFor("typeof window.releaseRetryRead === 'function'")
                if (supersession === "selection") {
                    await page.evaluate(`window.reader.workspace.open(${JSON.stringify(ids[1])})`)
                    await page.waitFor(
                        "window.reader.totalPages === 8 && document.querySelectorAll('.fullscreen-viewer').length === 1",
                    )
                } else {
                    await page.evaluate("window.reader.workspace.close()")
                    await page.waitFor(
                        "window.reader.workspace.snapshot.status === 'closed' && !document.querySelector('.fullscreen-viewer')",
                    )
                }
                await page.evaluate(
                    "document.activeElement?.blur(); window.selectionFocus = document.createElement('button'); window.selectionFocus.textContent = 'Current action'; document.body.append(window.selectionFocus); window.selectionFocus.focus(); window.releaseRetryRead()",
                )
                expect(await page.evaluate("window.retryResult")).toBe(false)
                expect(
                    await page.evaluate("document.activeElement === window.selectionFocus"),
                ).toBe(true)
                expect(await page.evaluate(snapshot)).toMatchObject({
                    documentId: supersession === "selection" ? ids[1] : null,
                    status: supersession === "selection" ? "ready" : "closed",
                })
                expect(
                    await page.evaluate("document.querySelectorAll('.fullscreen-viewer').length"),
                ).toBe(supersession === "selection" ? 1 : 0)
            } finally {
                await browser!.closeTarget(page.targetId)
            }
        },
        90000,
    )

    it("saves independent reading actions, closes/reopens, and restores only the current PDF on actual reload", async () => {
        const page = await browser!.page()
        try {
            await page.call("Page.navigate", { url: `${origin}/en` })
            await bind(page)
            expect(
                await page.evaluate(`(async () => {
                const results = await window.library.importFiles(['A', 'B'].map(name => ({name: name + '.pdf', source: new File([${JSON.stringify(pdf)}], name + '.pdf', {type: 'application/pdf'})})), null);
                window.ids = Object.fromEntries(results.map(result => [result.name[0], result.id]));
                return results.map(result => result.status);
            })()`),
            ).toEqual(["imported", "imported"])
            const ids = (await page.evaluate("window.ids")) as { A: string; B: string }
            await page.evaluate(`window.command('viewer.open', {bookId: ${JSON.stringify(ids.A)}})`)
            await page.waitFor(
                "window.reader.totalPages === 8 && !!document.querySelector('.fullscreen-viewer')",
            )
            await page.evaluate(`(async () => {
                await window.command('settings.zoom.in', {value: 2});
                await window.command('settings.layout', {value: 'split'});
                window.reader.goToPage(5, {scrollPosition: 0.3});
                await window.reader.workspace.flush();
            })()`)
            expect(await page.evaluate(snapshot)).toMatchObject({
                documentId: ids.A,
                status: "ready",
                state: { pageNumber: 5, scrollPosition: 0.3, scale: 2, layout: "split" },
            })
            await page.evaluate("window.reader.workspace.close()")
            expect(await page.evaluate(snapshot)).toMatchObject({
                documentId: null,
                status: "closed",
            })
            await page.evaluate(`window.command('viewer.open', {bookId: ${JSON.stringify(ids.A)}})`)
            expect(await page.evaluate(snapshot)).toMatchObject({
                documentId: ids.A,
                state: { pageNumber: 5, scrollPosition: 0.3, scale: 2, layout: "split" },
            })
            await page.evaluate(`window.command('viewer.open', {bookId: ${JSON.stringify(ids.B)}})`)
            await page.waitFor("window.reader.totalPages === 8")
            await page.evaluate(`(async () => {
                await window.command('settings.zoom.out', {value: 0.75});
                await window.command('settings.layout', {value: 'single'});
                window.reader.goToPage(3, {scrollPosition: 0.2});
                await window.reader.workspace.flush();
            })()`)
            expect(await page.evaluate(snapshot)).toMatchObject({
                documentId: ids.B,
                state: { pageNumber: 3, scrollPosition: 0.2, scale: 0.75, layout: "single" },
            })
            const persisted = await page.evaluate(records)
            expect(persisted).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({
                        value: {
                            version: 1,
                            documentId: ids.A,
                            pageNumber: 5,
                            scrollPosition: 0.3,
                            scale: 2,
                            layout: "split",
                        },
                    }),
                    expect.objectContaining({
                        value: {
                            version: 1,
                            documentId: ids.B,
                            pageNumber: 3,
                            scrollPosition: 0.2,
                            scale: 0.75,
                            layout: "single",
                        },
                    }),
                    expect.objectContaining({ value: { version: 1, documentId: ids.B } }),
                ]),
            )
            // Observe actual source/parser acquisition without replacing either implementation.
            await page.call("Page.addScriptToEvaluateOnNewDocument", {
                source: `
                window.pdfSources = [];
                const create = URL.createObjectURL.bind(URL);
                URL.createObjectURL = blob => {
                    if (blob.type === 'application/pdf') window.pdfSources.push(blob.type);
                    return create(blob);
                };
                window.parserObservation = import('/src/lib/core/documents/document-service.ts').then(({DocumentService}) => {
                    window.parserOpens = [];
                    const open = DocumentService.prototype.open;
                    DocumentService.prototype.open = function(source, signal) {
                        window.parserOpens.push(source.name);
                        return open.call(this, source, signal);
                    };
                });
            `,
            })
            const previousDocument = await page.evaluate("performance.timeOrigin")
            await page.call("Page.reload")
            await page.waitFor(`${ready} && performance.timeOrigin !== ${previousDocument}`)
            await bind(page)
            await page.waitFor(
                "window.reader.totalPages === 8 && !!document.querySelector('.fullscreen-viewer')",
            )
            expect(await page.evaluate(snapshot)).toMatchObject({
                documentId: ids.B,
                status: "ready",
                state: { pageNumber: 3, scrollPosition: 0.2, scale: 0.75, layout: "single" },
            })
            expect(await page.evaluate("Object.keys(window.library.fileUrls)")).toEqual([ids.B])
            expect(await page.evaluate("window.pdfSources")).toEqual(["application/pdf"])
            expect(await page.evaluate("window.parserOpens")).toEqual(["B.pdf"])
            expect(await page.evaluate(records)).toEqual(persisted)
            await page.evaluate(`window.command('viewer.open', {bookId: ${JSON.stringify(ids.A)}})`)
            expect(await page.evaluate(snapshot)).toMatchObject({
                documentId: ids.A,
                state: { pageNumber: 5, scrollPosition: 0.3, scale: 2, layout: "split" },
            })
        } finally {
            await browser!.closeTarget(page.targetId)
        }
    }, 120000)

    it("keeps saved annotations keyboard-accessible on a narrow screen through document changes and reload", async () => {
        const page = await browser!.page()
        const key = async (name: string, code: string, number: number, modifiers = 0) => {
            await page.call("Input.dispatchKeyEvent", {
                type: "keyDown",
                key: name,
                code,
                windowsVirtualKeyCode: number,
                modifiers,
                text: modifiers === 0 && name === "Enter" ? "\r" : undefined,
            })
            await page.call("Input.dispatchKeyEvent", {
                type: "keyUp",
                key: name,
                code,
                windowsVirtualKeyCode: number,
                modifiers,
            })
        }
        try {
            await page.call("Emulation.setDeviceMetricsOverride", {
                width: 390,
                height: 844,
                deviceScaleFactor: 1,
                mobile: true,
            })
            await page.call("Page.navigate", { url: `${origin}/en` })
            await bind(page)
            const ids = (await page.evaluate(`(async () => {
                const results = await window.library.importFiles(['annotations-A', 'annotations-B'].map(name => ({name: name + '.pdf', source: new File([${JSON.stringify(pdf)}], name + '.pdf', {type: 'application/pdf'})})), null);
                await window.command('viewer.open', {bookId: results[0].id});
                await window.command('settings.layout', {value: 'single'});
                await window.command('settings.zoom.out', {value: 1});
                return results.map(result => result.id);
            })()`)) as string[]
            await page.waitFor(
                "window.reader.totalPages === 8 && !!document.querySelector('.textLayer[data-page=\"1\"] span')",
            )
            await page.evaluate(`(() => {
                const span = document.querySelector('.textLayer[data-page="1"] span');
                const range = document.createRange(); range.selectNodeContents(span);
                const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
                document.dispatchEvent(new Event('selectionchange'));
            })()`)
            await page.waitFor("!!document.querySelector('.note-fab button')")
            await page.evaluate("document.querySelector('.note-fab button').focus()")
            await key("Enter", "Enter", 13)
            await page.waitFor("!!document.querySelector('textarea')")
            await page.evaluate("document.querySelector('textarea').focus()")
            await page.call("Input.insertText", { text: "<img src=x onerror=alert(1)> note" })
            await page.evaluate("document.querySelector('[aria-label=\"Select purple\"]').focus()")
            await key("Enter", "Enter", 13)
            expect(
                await page.evaluate(`(() => {
                const modal = document.querySelector('[role=dialog]').getBoundingClientRect();
                const text = document.querySelector('textarea').getBoundingClientRect();
                return modal.left >= 0 && modal.right <= innerWidth + 1 && text.width > 100 && !document.querySelector('[role=dialog] img');
            })()`),
            ).toBe(true)
            // Inject a single real storage-I/O failure, not a substitute annotation store.
            await page.evaluate(`(async () => {
                const {IndexedDBStorageBackend} = await import('/src/lib/core/storage/index.ts');
                const set = IndexedDBStorageBackend.prototype.set;
                window.failNextAnnotationSave = true;
                IndexedDBStorageBackend.prototype.set = async function(key, value) {
                    if (window.failNextAnnotationSave && key.includes(':reading-v1-annotations-')) {
                        window.failNextAnnotationSave = false;
                        throw new Error('private storage diagnostic');
                    }
                    return set.call(this, key, value);
                };
            })()`)
            await page.evaluate("document.querySelector('textarea').focus()")
            await key("Enter", "Enter", 13, 2)
            await page.waitFor("!!document.querySelector('[role=dialog] [role=alert]')")
            expect(await page.evaluate("document.querySelector('textarea').value")).toBe(
                "<img src=x onerror=alert(1)> note",
            )
            expect(
                await page.evaluate("document.querySelector('[role=dialog]').textContent"),
            ).not.toContain("private storage diagnostic")
            await key("Enter", "Enter", 13, 2)
            await page.waitFor(
                "!document.querySelector('textarea') && window.notes.notes.length === 1",
            )
            expect(
                await page.evaluate(
                    `window.reader.workspace.annotations(${JSON.stringify(ids[0])}).notes`,
                ),
            ).toMatchObject([
                {
                    bookId: ids[0],
                    text: "Reading passage",
                    noteContent: "<img src=x onerror=alert(1)> note",
                    color: "purple",
                },
            ])
            await page.evaluate("document.activeElement?.blur(); getSelection().removeAllRanges()")
            await key("b", "KeyB", 66)
            await page.waitFor("document.activeElement?.id === 'header-bookmark-name-input'")
            await page.evaluate("document.querySelector('#header-bookmark-name-input').select()")
            await page.call("Input.insertText", { text: "Chapter <img src=x>" })
            await page.evaluate("window.failNextAnnotationSave = true")
            await key("Enter", "Enter", 13)
            await page.waitFor("!!document.querySelector('[role=dialog] [role=alert]')")
            expect(
                await page.evaluate("document.querySelector('#header-bookmark-name-input').value"),
            ).toBe("Chapter <img src=x>")
            await key("Enter", "Enter", 13)
            await page.waitFor(
                "!document.querySelector('#header-bookmark-name-input') && window.bookmarks.bookmarks.length > 0",
            )
            expect(
                await page.evaluate(`window.library.getReadingSummary(${JSON.stringify(ids[0])})`),
            ).toEqual({ documentId: ids[0], noteCount: 1, bookmarkCount: 1 })
            await page.evaluate(
                `window.command('viewer.open', {bookId: ${JSON.stringify(ids[1])}})`,
            )
            await page.waitFor("window.reader.totalPages === 8 && window.notes.notes.length === 0")
            expect(
                await page.evaluate(`window.library.getReadingSummary(${JSON.stringify(ids[1])})`),
            ).toEqual({ documentId: ids[1], noteCount: 0, bookmarkCount: 0 })
            await page.evaluate(
                `(async () => { await window.reader.workspace.close(); await window.command('viewer.open', {bookId: ${JSON.stringify(ids[0])}}); await window.reader.workspace.flush(); })()`,
            )
            const before = await page.evaluate("performance.timeOrigin")
            await page.call("Page.reload")
            await page.waitFor(`${ready} && performance.timeOrigin !== ${before}`)
            await bind(page)
            await page.waitFor("window.reader.totalPages === 8 && window.notes.notes.length === 1")
            expect(
                await page.evaluate("document.querySelectorAll('.fullscreen-viewer').length"),
            ).toBe(1)
            await page.evaluate("window.ui.execute('viewer.sidebar.notes.toggle')")
            await page.waitFor(
                "(() => { const button = document.querySelector('.note-card [aria-label=\"Edit note\"]'); return button && !button.closest('[inert]') && button.getBoundingClientRect().left >= 0; })()",
            )
            expect(
                await page.evaluate("document.querySelector('.note-card').textContent"),
            ).toContain("<img src=x onerror=alert(1)> note")
            expect(await page.evaluate("document.querySelector('.note-card img') === null")).toBe(
                true,
            )
            await page.evaluate(
                "document.querySelector('.note-card [aria-label=\"Edit note\"]').focus()",
            )
            await key("Enter", "Enter", 13)
            await page.waitFor("!!document.querySelector('textarea')")
            await page.evaluate(
                "document.querySelector('textarea').focus(); document.querySelector('textarea').select()",
            )
            await page.call("Input.insertText", { text: "Updated after reload" })
            await key("Enter", "Enter", 13, 2)
            await page.waitFor("!document.querySelector('textarea')")
            expect(
                await page.evaluate(
                    `window.reader.workspace.annotations(${JSON.stringify(ids[0])}).notes[0].noteContent`,
                ),
            ).toBe("Updated after reload")
            await page.evaluate("window.ui.execute('viewer.sidebar.bookmarks.toggle')")
            await page.waitFor("!!document.querySelector('.bookmark-card')")
            expect(
                await page.evaluate("document.querySelector('.bookmark-card').textContent"),
            ).toContain("Chapter <img src=x>")
            expect(
                await page.evaluate("document.querySelector('.bookmark-card img') === null"),
            ).toBe(true)
            await page.waitFor(
                "(() => { const button = document.querySelector('.bookmark-card [aria-label=\"Edit Bookmark\"]'); return button && !button.closest('[inert]'); })()",
            )
            await page.evaluate(
                "document.querySelector('.bookmark-card [aria-label=\"Edit Bookmark\"]').focus()",
            )
            await key("Enter", "Enter", 13)
            await page.waitFor("document.activeElement?.id === 'edit-bookmark-name-input'")
            await page.evaluate("document.querySelector('#edit-bookmark-name-input').select()")
            await page.call("Input.insertText", { text: "Renamed after reload" })
            await key("Enter", "Enter", 13, 2)
            await page.waitFor("!document.querySelector('#edit-bookmark-name-input')")
            expect(
                await page.evaluate(
                    `window.reader.workspace.annotations(${JSON.stringify(ids[0])}).bookmarks[0].name`,
                ),
            ).toBe("Renamed after reload")
            await page.evaluate(
                "document.querySelector('.bookmark-card [aria-label=\"Remove Bookmark\"]').focus()",
            )
            await key("Enter", "Enter", 13)
            await page.waitFor("!!document.querySelector('[role=alertdialog]')")
            await page.evaluate(
                "document.querySelector('[role=alertdialog] .confirmation-danger').focus()",
            )
            await key("Enter", "Enter", 13)
            await page.waitFor("!document.querySelector('[role=alertdialog]')")
            expect(
                await page.evaluate(`window.library.getReadingSummary(${JSON.stringify(ids[0])})`),
            ).toEqual({ documentId: ids[0], noteCount: 1, bookmarkCount: 0 })
            await page.evaluate("window.ui.execute('viewer.sidebar.notes.toggle')")
            await page.waitFor(
                "(() => { const button = document.querySelector('.note-card [aria-label=\"Delete highlight and note\"]'); return button && !button.closest('[inert]'); })()",
            )
            await page.evaluate(
                "document.querySelector('.note-card [aria-label=\"Delete highlight and note\"]').focus()",
            )
            await key("Enter", "Enter", 13)
            await page.waitFor("!!document.querySelector('[role=alertdialog]')")
            await page.evaluate(
                "document.querySelector('[role=alertdialog] .confirmation-danger').focus()",
            )
            await key("Enter", "Enter", 13)
            await page.waitFor("!document.querySelector('[role=alertdialog]')")
            expect(
                await page.evaluate(`window.library.getReadingSummary(${JSON.stringify(ids[0])})`),
            ).toEqual({ documentId: ids[0], noteCount: 0, bookmarkCount: 0 })
        } finally {
            await browser!.closeTarget(page.targetId)
        }
    }, 120000)

    it.each([1280, 390])(
        "recovers independent drafts on actual reload and offers accessible close choices at %ipx",
        async (width) => {
            const page = await browser!.page()
            const enter = async () => {
                await page.call("Input.dispatchKeyEvent", {
                    type: "keyDown",
                    key: "Enter",
                    code: "Enter",
                    windowsVirtualKeyCode: 13,
                    text: "\r",
                })
                await page.call("Input.dispatchKeyEvent", {
                    type: "keyUp",
                    key: "Enter",
                    code: "Enter",
                    windowsVirtualKeyCode: 13,
                })
            }
            const choose = async (label: string) => {
                await page.waitFor(
                    "!!document.activeElement?.closest('[aria-labelledby=reading-close-decision-title]')",
                )
                await page.evaluate(
                    `Array.from(document.querySelectorAll('[aria-labelledby=reading-close-decision-title] button')).find(button => button.textContent.trim() === ${JSON.stringify(label)}).focus()`,
                )
                await enter()
            }
            try {
                await page.call("Emulation.setDeviceMetricsOverride", {
                    width,
                    height: 844,
                    deviceScaleFactor: 1,
                    mobile: width < 500,
                })
                await page.call("Page.navigate", { url: `${origin}/en` })
                await bind(page)
                const ids = (await page.evaluate(`(async () => {
                const results = await window.library.importFiles(['draft-A-${width}', 'draft-B-${width}'].map(name => ({name: name + '.pdf', source: new File([${JSON.stringify(pdf)}], name + '.pdf', {type:'application/pdf'})})), null);
                await window.command('viewer.open', {bookId: results[0].id});
                return results.map(result => result.id);
            })()`)) as string[]
                await page.waitFor(
                    "window.reader.totalPages === 8 && !!document.querySelector('.fullscreen-viewer')",
                )
                // Use the UI adapter after actual source identity is ready, not storage fixtures.
                await page.evaluate(`(async () => {
                await window.reader.workspace.loadDocument();
                await window.notes.openDraft({bookId:${JSON.stringify(ids[0])}, pageNumber:1, start:0, end:7, text:'<img src=x onerror=alert(1)> passage', noteContent:'First unfinished', color:'blue'});
                await window.notes.openDraft({bookId:${JSON.stringify(ids[0])}, pageNumber:2, start:8, end:14, text:'Other passage', noteContent:'Second unfinished', color:'purple'});
                await window.command('viewer.open', {bookId:${JSON.stringify(ids[1])}});
            })()`)
                await page.waitFor("window.notes.editors.length === 0")
                await page.evaluate(`(async () => {
                    await window.reader.workspace.loadDocument();
                    await window.notes.openDraft({bookId:${JSON.stringify(ids[1])}, pageNumber:3, start:0, end:1, text:'B', noteContent:'Only B', color:'pink'});
                })()`)
                await page.waitFor("document.querySelectorAll('textarea').length === 1")
                expect(
                    await page.evaluate(
                        "Array.from(document.querySelectorAll('textarea')).map(node => node.value)",
                    ),
                ).toEqual(["Only B"])
                await page.evaluate(
                    `window.command('viewer.open', {bookId:${JSON.stringify(ids[0])}})`,
                )
                await page.waitFor("document.querySelectorAll('textarea').length === 2")
                await page.evaluate("window.reader.workspace.flush()")
                const before = await page.evaluate("performance.timeOrigin")
                await page.call("Page.reload")
                await page.waitFor(`${ready} && performance.timeOrigin !== ${before}`)
                await bind(page)
                await page.waitFor("document.querySelectorAll('textarea').length === 2")
                expect(
                    await page.evaluate(
                        "Array.from(document.querySelectorAll('textarea')).map(node => node.value)",
                    ),
                ).toEqual(["First unfinished", "Second unfinished"])
                expect(
                    await page.evaluate(
                        "window.notes.drafts.map(draft => [draft.text, draft.color])",
                    ),
                ).toEqual([
                    ["<img src=x onerror=alert(1)> passage", "blue"],
                    ["Other passage", "purple"],
                ])
                expect(await page.evaluate("window.notes.notes.length")).toBe(0)
                expect(
                    await page.evaluate("document.querySelector('[role=dialog] img') === null"),
                ).toBe(true)
                await page.evaluate("window.ui.execute('viewer.close')")
                await page.waitFor(
                    "!!document.activeElement?.closest('[aria-labelledby=reading-close-decision-title]')",
                )
                expect(
                    await page.evaluate(`(() => {
                const dialog = document.querySelector('[aria-labelledby=reading-close-decision-title]');
                const buttons = Array.from(dialog.querySelectorAll('button'));
                return dialog.getAttribute('role') === 'dialog' && buttons.length === 3 && buttons.every(button => { const rect = button.getBoundingClientRect(); return rect.left >= 0 && rect.right <= innerWidth + 1 && rect.height >= 30 });
            })()`),
                ).toBe(true)
                await choose("Cancel")
                await page.waitFor(
                    "!document.querySelector('[aria-labelledby=reading-close-decision-title]')",
                )
                expect(await page.evaluate(snapshot)).toMatchObject({ documentId: ids[0] })
                expect(await page.evaluate("document.querySelectorAll('textarea').length")).toBe(2)
                // Header close is the same decision, even while draft editors are open.
                await page.evaluate(
                    "document.querySelector('[aria-label=\"Close document\"]').click()",
                )
                await page.waitFor(
                    "!!document.querySelector('[aria-labelledby=reading-close-decision-title]')",
                )
                await choose("Save")
                await page.waitFor(
                    "location.pathname === '/en' && !document.querySelector('.fullscreen-viewer')",
                )
                expect(
                    await page.evaluate(
                        `window.reader.workspace.annotations(${JSON.stringify(ids[0])}).notes.map(note => [note.noteContent,note.association.verification])`,
                    ),
                ).toEqual([
                    ["First unfinished", "unverified"],
                    ["Second unfinished", "unverified"],
                ])
                await page.evaluate(
                    `window.command('viewer.open', {bookId:${JSON.stringify(ids[1])}})`,
                )
                await page.waitFor("document.querySelector('textarea')?.value === 'Only B'")
                await page.evaluate("window.ui.execute('viewer.close')")
                await page.waitFor(
                    "!!document.querySelector('[aria-labelledby=reading-close-decision-title]')",
                )
                await page.evaluate(`(async () => {
                const { IndexedDBStorageBackend } = await import('/src/lib/core/storage/index.ts');
                const set = IndexedDBStorageBackend.prototype.set;
                let fail = true;
                IndexedDBStorageBackend.prototype.set = async function(key, value) {
                    if (fail && key.includes(':reading-v1-annotations-')) { fail = false; throw new Error('private close failure'); }
                    return set.call(this, key, value);
                };
            })()`)
                await choose("Save")
                await page.waitFor(
                    "!!document.querySelector('[aria-labelledby=reading-close-decision-title] [role=alert]')",
                )
                expect(await page.evaluate("window.reader.workspace.snapshot.documentId")).toBe(
                    ids[1],
                )
                expect(await page.evaluate("document.querySelector('textarea').value")).toBe(
                    "Only B",
                )
                expect(await page.evaluate("document.body.textContent")).not.toContain(
                    "private close failure",
                )
                await choose("Discard")
                await page.waitFor(
                    "location.pathname === '/en' && !document.querySelector('.fullscreen-viewer')",
                )
                expect(
                    await page.evaluate(
                        `window.reader.workspace.annotations(${JSON.stringify(ids[1])})`,
                    ),
                ).toMatchObject({ drafts: [], notes: [] })
                await page.evaluate(
                    `window.command('viewer.open', {bookId:${JSON.stringify(ids[1])}})`,
                )
                const discarded = await page.evaluate("performance.timeOrigin")
                await page.call("Page.reload")
                await page.waitFor(`${ready} && performance.timeOrigin !== ${discarded}`)
                await bind(page)
                await page.waitFor("window.reader.totalPages === 8")
                expect(await page.evaluate("document.querySelectorAll('textarea').length")).toBe(0)
                expect(
                    await page.evaluate("document.querySelectorAll('.fullscreen-viewer').length"),
                ).toBe(1)
                await page.evaluate("document.activeElement?.blur()")
                await page.call("Input.dispatchKeyEvent", {
                    type: "keyDown",
                    key: "q",
                    code: "KeyQ",
                    windowsVirtualKeyCode: 81,
                    text: "q",
                })
                await page.call("Input.dispatchKeyEvent", {
                    type: "keyUp",
                    key: "q",
                    code: "KeyQ",
                    windowsVirtualKeyCode: 81,
                })
                await page.waitFor(
                    "location.pathname === '/en' && window.reader.workspace.snapshot.documentId === null",
                )
            } finally {
                await browser!.closeTarget(page.targetId)
            }
        },
        120000,
    )

    it("presents unavailable-source drafts for review without reviving unverified editors", async () => {
        const page = await browser!.page()
        try {
            await page.call("Page.navigate", { url: `${origin}/en` })
            await bind(page)
            const id = await page.evaluate(`(async () => {
                const [result] = await window.library.importFiles([{name:'unavailable-draft.pdf', source:new File([${JSON.stringify(pdf)}], 'unavailable-draft.pdf', {type:'application/pdf'})}], null);
                await window.command('viewer.open', {bookId:result.id});
                return result.id;
            })()`)
            await page.waitFor("window.reader.totalPages === 8")
            await page.evaluate(
                `window.notes.openDraft({bookId:${JSON.stringify(id)},pageNumber:2,start:0,end:7,text:'Retained passage',noteContent:'Unloaded unfinished',color:'green'})`,
            )
            // Corrupt only this imported fixture's bytes. The real format adapter and
            // PDF.js must fail on reload; no project document service is replaced.
            await page.evaluate(`new Promise((resolve, reject) => {
                const request = indexedDB.open('vfs-extension-storage', 1);
                request.onerror = () => reject(request.error);
                request.onsuccess = () => {
                    const database = request.result;
                    const transaction = database.transaction('values', 'readwrite');
                    transaction.objectStore('values').put({
                        key: 'extension:builtin.library:library:fileContents.' + ${JSON.stringify(id)},
                        value: {id: ${JSON.stringify(id)}, file: new Blob(['%PDF-1.4\\nprivate parser failure\\n%%EOF'], {type: 'application/pdf'})}
                    });
                    transaction.oncomplete = () => { database.close(); resolve(true); };
                    transaction.onabort = () => { database.close(); reject(transaction.error); };
                };
            })`)
            const parserReload = await page.evaluate("performance.timeOrigin")
            await page.call("Page.reload")
            await page.waitFor(`${ready} && performance.timeOrigin !== ${parserReload}`)
            await bind(page)
            await page.waitFor(
                "document.querySelector('[data-reading-state=provider-unavailable][role=status]')?.textContent.includes('Viewer is unavailable') && document.querySelector('section[aria-label=\"Needs review\"]')?.textContent.includes('Unloaded unfinished')",
            )
            expect(await page.evaluate("window.reader.workspace.snapshot.documentId")).toBe(id)
            expect(await page.evaluate("document.body.textContent")).not.toContain(
                "private parser failure",
            )
            expect(await page.evaluate("document.body.textContent")).not.toContain(
                "Invalid PDF structure",
            )
            await page.evaluate(`new Promise((resolve,reject) => {
                const request=indexedDB.open('vfs-extension-storage',1);
                request.onsuccess=()=>{const db=request.result;const transaction=db.transaction('values','readwrite');transaction.objectStore('values').delete('extension:builtin.library:library:fileContents.'+${JSON.stringify(id)});transaction.oncomplete=()=>{db.close();resolve(true)};transaction.onabort=()=>reject(transaction.error)};
            })`)
            const before = await page.evaluate("performance.timeOrigin")
            await page.call("Page.reload")
            await page.waitFor(`${ready} && performance.timeOrigin !== ${before}`)
            await bind(page)
            await page.waitFor(
                "window.reader.workspace.snapshot.status === 'unavailable' && document.querySelector('section[aria-label=\"Needs review\"]')?.textContent.includes('Unloaded unfinished')",
            )
            expect(await page.evaluate("window.notes.notes.length")).toBe(0)
            expect(await page.evaluate("document.querySelector('textarea') === null")).toBe(true)
            expect(
                await page.evaluate(
                    `window.reader.workspace.needsReview(${JSON.stringify(id)}).length`,
                ),
            ).toBe(1)
            await nativeRetry(page, 'section[aria-label="Needs review"] button')
            await page.waitFor(
                "Array.from(document.querySelectorAll('[role=status]')).some(node => node.textContent.includes('Copied. The anchor is still unverified.'))",
            )
            expect(
                await page.evaluate(
                    `window.reader.workspace.annotations(${JSON.stringify(id)}).drafts.length`,
                ),
            ).toBe(1)
            await page.evaluate("window.ui.execute('viewer.close')")
            await page.waitFor(
                "!!document.querySelector('[aria-labelledby=reading-close-decision-title]')",
            )
            await page.evaluate("document.querySelector('#reading-close-cancel').click()")
            await page.waitFor(
                "!document.querySelector('[aria-labelledby=reading-close-decision-title]')",
            )
            expect(await page.evaluate(snapshot)).toMatchObject({
                documentId: id,
                status: "unavailable",
            })
        } finally {
            await browser!.closeTarget(page.targetId)
        }
    }, 90000)

    it("keeps annotations stable during native scrolling and loads them on document switches", async () => {
        const page = await browser!.page()
        try {
            await page.call("Emulation.setDeviceMetricsOverride", {
                width: 1280,
                height: 800,
                deviceScaleFactor: 1,
                mobile: false,
            })
            await page.call("Page.navigate", { url: `${origin}/en` })
            await bind(page)
            const ids = (await page.evaluate(`(async () => {
                const results = await window.library.importFiles(['scroll-notes-a.pdf', 'scroll-notes-b.pdf'].map(name => ({name, source: new File([${JSON.stringify(pdf)}], name, {type: 'application/pdf'})})), null);
                await window.command('viewer.open', {bookId: results[0].id});
                await window.command('settings.layout', {value: 'scroll'});
                await window.command('settings.zoom.out', {value: 1.5});
                return results.map(result => result.id);
            })()`)) as string[]
            await page.waitFor(`window.reader.totalPages === 8
                && document.querySelector('.scroll-page[data-page="1"] .page-container')?.getBoundingClientRect().height === 600
                && !!document.querySelector('.scroll-page[data-page="1"] .textLayer span')`)
            await page.evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => {
                window.annotationLoads = [];
                window.annotationRangeBuilds = 0;
                window.initialNotes = window.notes.notes;
                const load = window.notes.loadNotesForBook.bind(window.notes);
                window.notes.loadNotesForBook = id => {
                    window.annotationLoads.push(id);
                    return load(id);
                };
                const register = window.notes.registerPageRanges.bind(window.notes);
                window.notes.registerPageRanges = (page, ranges) => {
                    if (page === 1) window.annotationRangeBuilds++;
                    return register(page, ranges);
                };
                window.nativeScrollEvents = 0;
                document.querySelector('.scroll-mode .canvas-frame').addEventListener('scroll', event => {
                    if (event.isTrusted) window.nativeScrollEvents++;
                });
                resolve(true);
            })))`)
            // Stay on the same mounted page, so virtual page entry cannot explain range work.
            for (const top of [30, 60, 90]) {
                await page.evaluate(
                    `document.querySelector('.scroll-mode .canvas-frame').scrollTo({top: ${top}, behavior: 'instant'})`,
                )
                await page.waitFor(`window.reader.currentPage === 1
                    && Math.abs(window.reader.scrollPosition - ${top} / document.querySelector('.scroll-page[data-page="1"] .page-container').getBoundingClientRect().height) < 0.001`)
                await page.evaluate(
                    `new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))`,
                )
            }
            expect(await page.evaluate("window.nativeScrollEvents")).toBeGreaterThanOrEqual(3)
            expect(await page.evaluate("window.annotationLoads")).toEqual([])
            expect(await page.evaluate("window.notes.notes === window.initialNotes")).toBe(true)
            expect(await page.evaluate("window.annotationRangeBuilds")).toBe(0)

            const afterMetadata = await page.evaluate(`(async () => {
                const {PagedPdfDocument} = await import('/src/lib/extensions/builtin/pdf/pdf-document.ts');
                const getPage = PagedPdfDocument.prototype.getPage;
                const dimensionReads = [];
                PagedPdfDocument.prototype.getPage = function(page) {
                    dimensionReads.push(page);
                    return getPage.call(this, page);
                };
                const text = document.querySelector('.scroll-page[data-page="1"] .textLayer span');
                try {
                    await window.reader.updateBook({...window.reader.getCurrentBook()});
                    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
                    return {
                        dimensionReads,
                        scrollTop: document.querySelector('.scroll-mode .canvas-frame').scrollTop,
                        sameText: text === document.querySelector('.scroll-page[data-page="1"] .textLayer span'),
                    };
                } finally {
                    PagedPdfDocument.prototype.getPage = getPage;
                }
            })()`)
            expect(afterMetadata).toEqual({ dimensionReads: [], scrollTop: 90, sameText: true })
            expect(await page.evaluate("window.annotationLoads")).toEqual([])
            expect(await page.evaluate("window.annotationRangeBuilds")).toBe(0)

            await page.evaluate(
                `window.command('viewer.open', {bookId: ${JSON.stringify(ids[1])}})`,
            )
            await page.waitFor(`window.reader.workspace.snapshot.documentId === ${JSON.stringify(ids[1])}
                && window.reader.totalPages === 8
                && window.annotationLoads.includes(${JSON.stringify(ids[1])})`)
            expect(await page.evaluate("window.annotationLoads")).toEqual([ids[1]])
            expect(await page.evaluate("window.notes.notes === window.initialNotes")).toBe(false)
        } finally {
            await browser!.closeTarget(page.targetId)
        }
    }, 90000)

    it("restores a negative page-relative position produced by native viewport scrolling after reload", async () => {
        const page = await browser!.page()
        try {
            await page.call("Emulation.setDeviceMetricsOverride", {
                width: 1280,
                height: 800,
                deviceScaleFactor: 1,
                mobile: false,
            })
            await page.call("Page.navigate", { url: `${origin}/en` })
            await bind(page)
            const id = await page.evaluate(`(async () => {
                const {viewerSettingsCapability} = await import('/src/lib/extensions/builtin/viewer/viewerHost.ts');
                if (viewerSettingsCapability.settingsStore.animations) await window.command('settings.animations.toggle');
                const [result] = await window.library.importFiles([{name: 'native-scroll.pdf', source: new File([${JSON.stringify(pdf)}], 'native-scroll.pdf', {type: 'application/pdf'})}], null);
                await window.command('viewer.open', {bookId: result.id});
                await window.command('settings.layout', {value: 'scroll'});
                await window.command('settings.zoom.out', {value: 1});
                return result.id;
            })()`)
            await page.waitFor(`(() => {
                const pane = document.querySelector('.canvas-pane.scroll-mode:not(.animations-enabled)');
                const second = pane?.querySelector('.scroll-page[data-page="2"] .page-container');
                return window.reader.totalPages === 8 && second?.getBoundingClientRect().height === 400;
            })()`)
            // Literal fixture geometry: 400px pages at 100% zoom, 80px desktop gaps.
            // Page 2 starts at 480px. Scroll to 360px: its top remains 120px below
            // the viewport top, while the viewport midpoint selects page 2 => offset -0.3.
            await page.evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => {
                const frame = document.querySelector('.scroll-mode .canvas-frame');
                window.nativeScrollEvents = 0;
                window.nativeScrollSettled = false;
                frame.addEventListener('scroll', event => { if (event.isTrusted) window.nativeScrollEvents++; });
                frame.addEventListener('scrollend', () => window.nativeScrollSettled = true, {once: true});
                frame.scrollTo({top: 360, behavior: 'instant'});
                resolve(true);
            })))`)
            await page.waitFor(`window.nativeScrollSettled && window.nativeScrollEvents > 0
                && window.reader.workspace.snapshot.state.pageNumber === 2
                && Math.abs(window.reader.workspace.snapshot.state.scrollPosition + 0.3) < 0.0001`)
            const geometry = `(() => {
                const frame = document.querySelector('.scroll-mode .canvas-frame');
                const second = frame.querySelector('.scroll-page[data-page="2"]');
                return {
                    scrollTop: frame.scrollTop,
                    viewportHeight: frame.clientHeight,
                    pageTop: second.getBoundingClientRect().top - frame.getBoundingClientRect().top,
                    pageHeight: second.querySelector('.page-container').getBoundingClientRect().height,
                };
            })()`
            const before = (await page.evaluate(geometry)) as {
                scrollTop: number
                viewportHeight: number
                pageTop: number
                pageHeight: number
            }
            expect(before.scrollTop).toBeCloseTo(360, 0)
            expect(before.pageTop).toBeCloseTo(120, 0)
            expect(before.pageHeight).toBeCloseTo(400, 0)
            expect(before.viewportHeight).toBeGreaterThan(400)
            expect(before.viewportHeight).toBeLessThan(800)
            expect(await page.evaluate(snapshot)).toEqual({
                documentId: id,
                status: "ready",
                state: { pageNumber: 2, scrollPosition: -0.3, scale: 1, layout: "scroll" },
            })
            await page.evaluate("window.reader.workspace.flush()")
            expect(await page.evaluate(records)).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({
                        value: {
                            version: 1,
                            documentId: id,
                            pageNumber: 2,
                            scrollPosition: -0.3,
                            scale: 1,
                            layout: "scroll",
                        },
                    }),
                ]),
            )
            const previousDocument = await page.evaluate("performance.timeOrigin")
            await page.call("Page.reload")
            await page.waitFor(`${ready} && performance.timeOrigin !== ${previousDocument}`)
            await bind(page)
            await page.waitFor(`(() => {
                const frame = document.querySelector('.scroll-mode .canvas-frame');
                return window.reader.totalPages === 8 && frame
                    && Math.abs(frame.scrollTop - 360) < 2
                    && !!frame.querySelector('.scroll-page[data-page="2"] img');
            })()`)
            expect(await page.evaluate(snapshot)).toEqual({
                documentId: id,
                status: "ready",
                state: { pageNumber: 2, scrollPosition: -0.3, scale: 1, layout: "scroll" },
            })
            const restored = (await page.evaluate(geometry)) as typeof before
            expect(restored.scrollTop).toBeCloseTo(360, 0)
            expect(restored.pageTop).toBeCloseTo(120, 0)
            expect(restored.pageHeight).toBeCloseTo(400, 0)
            expect(restored.viewportHeight).toBe(before.viewportHeight)
        } finally {
            await browser!.closeTarget(page.targetId)
        }
    }, 90000)

    it.each([1280, 390])(
        "reviews changed-content relinks by keyboard and persists explicit discard at %ipx",
        async (width) => {
            const page = await browser!.page()
            try {
                await page.call("Emulation.setDeviceMetricsOverride", {
                    width,
                    height: 844,
                    deviceScaleFactor: 1,
                    mobile: width === 390,
                })
                await page.call("Page.navigate", { url: `${origin}/en` })
                await bind(page)
                const id = await page.evaluate(`(async () => {
                const [result] = await window.library.importFiles([{name:'review.pdf', source:new File([${JSON.stringify(pdf)}], 'review.pdf', {type:'application/pdf'})}], null);
                await window.command('viewer.open', {bookId:result.id});
                return result.id;
            })()`)
                await page.waitFor(
                    "window.reader.totalPages === 8 && !!document.querySelector('.textLayer span')",
                )
                await page.evaluate(`(async () => {
                const id = ${JSON.stringify(id)};
                const input = {pageNumber:2,start:0,end:7,text:'<img src=x> preserved',noteContent:'Private review note',color:'blue',association:{contentHash:null,verification:'unverified'}};
                await window.reader.workspace.createNote(id,input);
                await window.reader.workspace.createDraft(id,{...input,noteContent:'Unfinished review draft'});
                await window.notes.closeEditor();
                await window.reader.workspace.createBookmark(id,{pageNumber:8,name:'Old chapter',association:input.association});
                window.reader.workspace.requestRelink();
            })()`)
                await page.waitFor("!!document.querySelector('input[type=file]')")
                // Keyboard users can reach the existing Library locate control. File selection
                // itself is supplied at the browser boundary, as in the existing relink test.
                expect(
                    await page.evaluate(
                        `Array.from(document.querySelectorAll('[role=dialog] button')).some(button => button.textContent.trim() === 'Locate File' && button.tabIndex === 0)`,
                    ),
                ).toBe(true)
                await page.evaluate(`(() => {
                const transfer = new DataTransfer();
                transfer.items.add(new File([${JSON.stringify(pdf.replace("Reading passage", "Changed passage"))}], 'review.pdf', {type:'application/pdf'}));
                const input = document.querySelector('input[type=file]');
                input.files = transfer.files;
                input.dispatchEvent(new Event('change', {bubbles:true}));
            })()`)
                await page.waitFor(
                    `!document.querySelector('[role=dialog]') && window.reader.workspace.needsReview(${JSON.stringify(id)}).length === 3 && window.notes.notes.length === 0`,
                )
                await page.evaluate("window.ui.execute('viewer.sidebar.notes.toggle')")
                const review = 'section[aria-label="Needs review"]'
                await page.waitFor(
                    `document.querySelector(${JSON.stringify(review)})?.textContent.includes('Unfinished review draft')`,
                )
                expect(
                    await page.evaluate(`(() => {
                const region = document.querySelector(${JSON.stringify(review)});
                return region.querySelectorAll('li').length === 3 && !region.querySelector('img,script')
                    && Array.from(region.querySelectorAll('button')).every(button => {
                        const rect = button.getBoundingClientRect();
                        return rect.left >= 0 && rect.right <= innerWidth + 1 && rect.height >= 30;
                    });
            })()`),
                ).toBe(true)
                await nativeRetry(page, `${review} li button`)
                await page.waitFor(
                    "Array.from(document.querySelectorAll('[role=status]')).some(node => node.textContent.includes('Copied. The anchor is still unverified.'))",
                )
                expect(
                    await page.evaluate(
                        `window.reader.workspace.needsReview(${JSON.stringify(id)}).length`,
                    ),
                ).toBe(3)
                await nativeRetry(page, `${review} li button:nth-of-type(2)`)
                await page.waitFor(
                    `window.reader.workspace.needsReview(${JSON.stringify(id)}).length === 2`,
                )
                await page.evaluate("window.reader.workspace.flush()")
                const previous = await page.evaluate("performance.timeOrigin")
                await page.call("Page.reload")
                await page.waitFor(`${ready} && performance.timeOrigin !== ${previous}`)
                await bind(page)
                await page.waitFor("window.reader.totalPages === 8")
                await page.evaluate("window.ui.execute('viewer.sidebar.notes.toggle')")
                await page.waitFor(
                    `document.querySelector(${JSON.stringify(review)})?.querySelectorAll('li').length === 2`,
                )
                expect(
                    await page.evaluate(
                        `window.reader.workspace.anchoredAnnotations(${JSON.stringify(id)})`,
                    ),
                ).toEqual({ notes: [], drafts: [], bookmarks: [] })
                expect(
                    await page.evaluate("document.querySelectorAll('.fullscreen-viewer').length"),
                ).toBe(1)
            } finally {
                await page
                    .evaluate("window.dispatchEvent(new PageTransitionEvent('pagehide'))")
                    .catch(() => undefined)
                page.close()
            }
        },
        90000,
    )

    it("retains an unavailable restored source and safely retries/relinks through Library UI", async () => {
        const page = await browser!.page()
        try {
            await page.call("Page.navigate", { url: `${origin}/en` })
            await bind(page)
            const id = await page.evaluate(`(async () => {
                const [result] = await window.library.importFiles([{name: '<img src=x onerror=alert(1)>.pdf', source: new File([${JSON.stringify(pdf)}], 'unavailable.pdf', {type: 'application/pdf'})}], null);
                return result.id;
            })()`)
            await page.evaluate(`window.command('viewer.open', {bookId: ${JSON.stringify(id)}})`)
            await page.waitFor(
                "window.reader.totalPages === 8 && !!document.querySelector('.fullscreen-viewer')",
            )
            await page.evaluate(`(async () => {
                await window.command('settings.zoom.in', {value: 1.75});
                await window.command('settings.layout', {value: 'single'});
                window.reader.goToPage(6, {scrollPosition: 0.4});
                await window.reader.workspace.flush();
            })()`)
            // Fixture: source becomes unavailable outside the reader. Keep the Library node,
            // new progress, and all unrelated files/unsupported records untouched.
            await page.evaluate(`new Promise((resolve, reject) => {
                const request = indexedDB.open('vfs-extension-storage', 1);
                request.onsuccess = () => {
                    const database = request.result;
                    const transaction = database.transaction('values', 'readwrite');
                    transaction.objectStore('values').delete('extension:builtin.library:library:fileContents.' + ${JSON.stringify(id)});
                    transaction.oncomplete = () => {database.close(); resolve(true)};
                    transaction.onabort = () => reject(transaction.error);
                };
            })`)
            const previousDocument = await page.evaluate("performance.timeOrigin")
            await page.call("Page.reload")
            await page.waitFor(`${ready} && performance.timeOrigin !== ${previousDocument}`)
            await bind(page)
            await page.waitFor(
                "document.querySelector('[data-reading-state=unavailable][role=status]')?.textContent.includes('Document access unavailable')",
            )
            const retained = {
                documentId: id,
                status: "unavailable",
                state: { pageNumber: 6, scrollPosition: 0.4, scale: 1.75, layout: "single" },
            }
            expect(await page.evaluate(snapshot)).toEqual(retained)
            expect(
                await page.evaluate("document.querySelector('.fullscreen-viewer') === null"),
            ).toBe(true)
            await page.evaluate(
                "Array.from(document.querySelectorAll('button')).find(button => button.textContent.trim() === 'Retry').click()",
            )
            await page.waitFor("!!document.querySelector('[role=dialog]')")
            expect(await page.evaluate(snapshot)).toEqual(retained)
            expect(
                await page.evaluate("document.querySelector('[role=dialog] img') === null"),
            ).toBe(true)
            expect(
                await page.evaluate("document.querySelector('[role=dialog]').textContent"),
            ).toContain("<img src=x onerror=alert(1)>.pdf")
            await page.evaluate(
                "Array.from(document.querySelectorAll('[role=dialog] button')).find(button => button.textContent.trim() === 'Cancel').click()",
            )
            await page.waitFor("document.querySelector('[role=dialog]') === null")
            expect(await page.evaluate(snapshot)).toEqual(retained)
            await page.evaluate(
                "Array.from(document.querySelectorAll('button')).find(button => button.textContent.trim() === 'Relink file').click()",
            )
            await page.waitFor("!!document.querySelector('[role=dialog]')")
            await page.evaluate(`(() => {
                const transfer = new DataTransfer();
                transfer.items.add(new File([${JSON.stringify(pdf)}], '<img src=x onerror=alert(1)>.pdf', {type: 'application/pdf'}));
                const input = document.querySelector('input[type=file]');
                input.files = transfer.files;
                input.dispatchEvent(new Event('change', {bubbles: true}));
            })()`)
            await page.waitFor(
                "!document.querySelector('[role=dialog]') && !!document.querySelector('.fullscreen-viewer') && window.reader.totalPages === 8",
            )
            expect(await page.evaluate(snapshot)).toEqual({ ...retained, status: "ready" })
            await page.evaluate("window.reader.workspace.flush()")
            expect(await page.evaluate(records)).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({ value: { version: 1, documentId: id } }),
                    expect.objectContaining({
                        value: {
                            version: 1,
                            documentId: id,
                            pageNumber: 6,
                            scrollPosition: 0.4,
                            scale: 1.75,
                            layout: "single",
                        },
                    }),
                ]),
            )
        } finally {
            await browser!.closeTarget(page.targetId)
        }
    }, 90000)

    it("blocks a same-origin contender and fences a delayed Reading save across retry/handoff", async () => {
        const old = await browser!.page()
        let next: BrowserPage | undefined
        try {
            await old.call("Page.navigate", { url: `${origin}/en` })
            await bind(old)
            const id = await old.evaluate(`(async () => {
                const [result] = await window.library.importFiles([{name: 'handoff.pdf', source: new File([${JSON.stringify(pdf)}], 'handoff.pdf', {type: 'application/pdf'})}], null);
                return result.id;
            })()`)
            // As in writer-browser.test.ts, suspend the shell before installing an observable
            // real browser application. It uses the same Web Lock and fenced IDB lifetime.
            await old.evaluate("window.dispatchEvent(new PageTransitionEvent('pagehide'))")
            await old.waitFor(
                "navigator.locks.query().then(result => result.held.every(lock => !lock.name.endsWith(':writer')))",
            )
            await old.evaluate(`(async () => {
                const {createBrowserApplication} = await import('/src/lib/app/bootstrap.ts');
                const {IndexedDBStorageBackend} = await import('/src/lib/core/storage/index.ts');
                window.writer = createBrowserApplication({storage: lifetime => window.backend = new IndexedDBStorageBackend({lifetime})});
                await window.writer.start();
                if (!window.writer.ready) throw new Error('Reading writer failed to acquire');
            })()`)
            await old.evaluate(bindings)
            await old.evaluate(`(async () => {
                await window.reader.workspace.open(${JSON.stringify(id)});
                await window.reader.workspace.loadDocument();
                await window.command('settings.layout', {value: 'single'});
                await window.command('settings.zoom.in', {value: 1.25});
                window.reader.goToPage(4, {scrollPosition: 0.1});
                await window.reader.workspace.flush();
            })()`)
            expect(await old.evaluate(snapshot)).toMatchObject({
                documentId: id,
                status: "ready",
                state: { pageNumber: 4, scrollPosition: 0.1, scale: 1.25, layout: "single" },
            })
            // Import/render before opening the background contender: Chromium throttles
            // PDF cover generation in a background page.
            next = await browser!.page()
            await next.call("Page.navigate", { url: `${origin}/en/viewer` })
            const blocked = "!!document.querySelector('[data-writer-state=blocked]')"
            const retry =
                "Array.from(document.querySelectorAll('button')).find(button => button.textContent.trim() === 'Try again').click()"
            await next.waitFor(blocked)
            expect(await next.evaluate("document.querySelector('h1')?.textContent")).toBe(
                "Library is open in another window",
            )
            expect(
                await next.evaluate(
                    "document.querySelectorAll('#app-root, input, textarea').length",
                ),
            ).toBe(0)
            const before = await next.evaluate(records)
            await next.evaluate(retry)
            await next.waitFor(blocked)
            expect(await next.evaluate(records)).toEqual(before)

            // Delay one actual reading-state write at the storage I/O boundary. The real
            // backend still decides whether the old lifetime may commit after handoff.
            await old.evaluate(`(() => {
                const set = window.backend.set.bind(window.backend);
                let delayed = false;
                window.backend.set = async (key, value) => {
                    if (!delayed && key.includes(':reading-v1-document-')) {
                        delayed = true;
                        await new Promise(resolve => window.finishOldSave = resolve);
                        try { await set(key, value); window.lateSave = 'incorrectly committed'; }
                        catch (error) { window.lateSave = 'rejected'; throw error; }
                        return;
                    }
                    return set(key, value);
                };
            })()`)
            await old.evaluate("window.command('settings.zoom.in', {value: 4})")
            await old.waitFor("typeof window.finishOldSave === 'function'")
            expect(await old.evaluate(snapshot)).toMatchObject({
                documentId: id,
                state: { scale: 4 },
            })
            await old.evaluate("window.writer.stop()")
            await next.waitFor(
                "navigator.locks.query().then(result => result.held.every(lock => !lock.name.endsWith(':writer')))",
            )
            await next.evaluate(retry)
            await bind(next)
            await next.waitFor(
                "window.reader.totalPages === 8 && !!document.querySelector('.fullscreen-viewer')",
            )
            expect(await next.evaluate(snapshot)).toMatchObject({
                documentId: id,
                status: "ready",
                state: { pageNumber: 4, scrollPosition: 0.1, scale: 1.25, layout: "single" },
            })
            await next.evaluate("window.command('settings.zoom.in', {value: 2.5})")
            await next.evaluate(
                "window.reader.goToPage(7, {scrollPosition: 0}); window.reader.workspace.flush()",
            )
            const newOwnerRecords = await next.evaluate(records)
            await old.evaluate("window.finishOldSave()")
            await old.waitFor("window.lateSave === 'rejected'")
            // Obsolete commands/workspace mutations cannot save after revocation either.
            await old.evaluate(
                "window.reader.goToPage(8); window.reader.scale = 5; window.reader.workspace.flush()",
            )
            expect(await next.evaluate(snapshot)).toMatchObject({
                documentId: id,
                state: { pageNumber: 7, scale: 2.5 },
            })
            expect(await next.evaluate(records)).toEqual(newOwnerRecords)
            expect(
                await next.evaluate(
                    "navigator.locks.query().then(result => result.held.filter(lock => lock.name.endsWith(':writer')).length)",
                ),
            ).toBe(1)
            const previousDocument = await next.evaluate("performance.timeOrigin")
            await next.call("Page.reload")
            await next.waitFor(`${ready} && performance.timeOrigin !== ${previousDocument}`)
            await bind(next)
            await next.waitFor("window.reader.totalPages === 8")
            expect(await next.evaluate(snapshot)).toMatchObject({
                documentId: id,
                status: "ready",
                state: { pageNumber: 7, scrollPosition: 0, scale: 2.5, layout: "single" },
            })
        } finally {
            await browser!.closeTarget(old.targetId)
            if (next) await browser!.closeTarget(next.targetId)
        }
    }, 90000)
    it("fences an actual delayed annotation write across same-origin writer handoff", async () => {
        const old = await browser!.page()
        let next: BrowserPage | undefined
        try {
            await old.call("Page.navigate", { url: `${origin}/en` })
            await bind(old)
            const id = await old.evaluate(`(async () => {
                const [result] = await window.library.importFiles([{name: 'annotation-writer.pdf', source: new File([${JSON.stringify(pdf)}], 'annotation-writer.pdf', {type: 'application/pdf'})}], null);
                return result.id;
            })()`)
            await old.evaluate("window.dispatchEvent(new PageTransitionEvent('pagehide'))")
            await old.waitFor(
                "navigator.locks.query().then(result => result.held.every(lock => !lock.name.endsWith(':writer')))",
            )
            await old.evaluate(`(async () => {
                const {createBrowserApplication} = await import('/src/lib/app/bootstrap.ts');
                const {IndexedDBStorageBackend} = await import('/src/lib/core/storage/index.ts');
                window.writer = createBrowserApplication({storage: lifetime => window.backend = new IndexedDBStorageBackend({lifetime})});
                await window.writer.start();
                if (!window.writer.ready) throw new Error('Writer unavailable');
            })()`)
            await old.evaluate(bindings)
            const bookmarkId = await old.evaluate(`(async () => {
                const result = await window.reader.workspace.createBookmark(${JSON.stringify(id)}, {pageNumber: 2, name: 'Original', association: {contentHash: null, verification: 'unverified'}});
                return result.value.id;
            })()`)
            await old.evaluate(`(() => {
                const set = window.backend.set.bind(window.backend);
                window.backend.set = async (key, value) => {
                    if (key.includes(':reading-v1-annotations-')) {
                        await new Promise(resolve => window.releaseAnnotationWrite = resolve);
                        try { await set(key, value); window.annotationWrite = 'committed'; }
                        catch (error) { window.annotationWrite = 'fenced'; throw error; }
                        return;
                    }
                    return set(key, value);
                };
                window.reader.workspace.updateBookmark(${JSON.stringify(id)}, ${JSON.stringify(bookmarkId)}, 'Late old owner').then(result => window.annotationResult = result.ok);
            })()`)
            await old.waitFor("typeof window.releaseAnnotationWrite === 'function'")
            next = await browser!.page()
            await next.call("Page.navigate", { url: `${origin}/en` })
            await next.waitFor("!!document.querySelector('[data-writer-state=blocked]')")
            expect(
                await next.evaluate("document.querySelectorAll('#app-root, textarea').length"),
            ).toBe(0)
            await old.evaluate("window.writer.stop()")
            await next.waitFor(
                "navigator.locks.query().then(result => result.held.every(lock => !lock.name.endsWith(':writer')))",
            )
            await next.evaluate(
                "Array.from(document.querySelectorAll('button')).find(button => button.textContent.trim() === 'Try again').click()",
            )
            await bind(next)
            expect(
                await next.evaluate(
                    `window.reader.workspace.annotations(${JSON.stringify(id)}).bookmarks`,
                ),
            ).toMatchObject([{ name: "Original" }])
            expect(
                await next.evaluate(
                    `window.reader.workspace.updateBookmark(${JSON.stringify(id)}, ${JSON.stringify(bookmarkId)}, 'New owner').then(result => result.ok)`,
                ),
            ).toBe(true)
            await old.evaluate("window.releaseAnnotationWrite()")
            await old.waitFor(
                "window.annotationWrite === 'fenced' && window.annotationResult === false",
            )
            const before = await next.evaluate("performance.timeOrigin")
            await next.call("Page.reload")
            await next.waitFor(`${ready} && performance.timeOrigin !== ${before}`)
            await bind(next)
            expect(
                await next.evaluate(
                    `window.reader.workspace.annotations(${JSON.stringify(id)}).bookmarks`,
                ),
            ).toMatchObject([{ name: "New owner" }])
            expect(
                await next.evaluate(
                    "navigator.locks.query().then(result => result.held.filter(lock => lock.name.endsWith(':writer')).length)",
                ),
            ).toBe(1)
        } finally {
            await browser!.closeTarget(old.targetId)
            if (next) await browser!.closeTarget(next.targetId)
        }
    }, 90000)
})
