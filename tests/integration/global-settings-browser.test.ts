import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { spawn, type ChildProcess } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Chromium, chromiumPath, terminate, type BrowserPage } from "../helpers/chromium"

// Real Chromium is mandatory: jsdom cannot establish geometry or native keyboard behavior.
describe("Global Settings browser", () => {
    let profile: string
    let browser: Chromium | undefined
    let server: ChildProcess | undefined
    let origin: string

    beforeAll(async () => {
        expect(existsSync(chromiumPath), `Chromium required at ${chromiumPath}`).toBe(true)
        profile = await mkdtemp(join(tmpdir(), "reader-global-settings-"))
        server = spawn(
            process.execPath,
            [
                "--input-type=module",
                "--eval",
                `
                const {createServer} = await import('vite');
                const {realpathSync} = await import('node:fs');
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
                () => reject(new Error(`Settings server startup timed out: ${log}`)),
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
                reject(new Error(`Settings server exited: ${log}`))
            })
        })
        browser = await Chromium.launch(profile)
        const versionPage = await browser.page()
        try {
            console.info("Settings native browser:", await versionPage.call("Browser.getVersion"))
        } finally {
            await browser.closeTarget(versionPage.targetId)
        }
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

    const dialog = '[role="dialog"]'
    const search = 'input[type="search"]'
    const close = '[aria-label="Close Settings"]'
    const buttonExpression = (name: string, scope = dialog) =>
        `Array.from(document.querySelectorAll(${JSON.stringify(`${scope} button`)})).find(node => node.textContent.trim() === ${JSON.stringify(name)} && node.getBoundingClientRect().width > 0)`
    const fieldExpression = (name: string) =>
        `document.getElementById(Array.from(document.querySelectorAll(${JSON.stringify(`${dialog} label`)})).find(node => node.textContent.trim() === ${JSON.stringify(name)}).htmlFor)`

    async function key(page: BrowserPage, key: string, shift = false) {
        const number = { Tab: 9, Enter: 13, Escape: 27, ArrowDown: 40, Home: 36, " ": 32 }[key]
        const code = key === " " ? "Space" : key
        await page.call("Input.dispatchKeyEvent", {
            type: "keyDown",
            key,
            code,
            windowsVirtualKeyCode: number,
            modifiers: shift ? 8 : 0,
            ...(key === "Enter" ? { text: "\r" } : key === " " ? { text: " " } : {}),
        })
        await page.call("Input.dispatchKeyEvent", {
            type: "keyUp",
            key,
            code,
            windowsVirtualKeyCode: number,
            modifiers: shift ? 8 : 0,
        })
    }

    async function click(page: BrowserPage, expression: string) {
        // Native pointer coordinates must be measured after the real surface intro/scroll,
        // not while the confirmation is moving underneath an immediate CDP click.
        await page.evaluate(`(() => {
            const node = ${expression};
            if (!node) throw new Error('Missing click target');
            if (!node.getBoundingClientRect().width) throw new Error('Hidden click target');
            node.scrollIntoView({block:'center', inline:'nearest', behavior:'instant'});
        })()`)
        await page.waitFor(`document.getAnimations().every(animation => {
            const target = animation.effect?.target;
            return !(target instanceof Element && target.contains(${expression})) || animation.playState !== 'running';
        })`)
        const point = (await page.evaluate(`(() => {
            const node = ${expression};
            if (!node) throw new Error('Click target disappeared');
            const rect = node.getBoundingClientRect();
            const x = rect.left + rect.width / 2, y = rect.top + rect.height / 2;
            const hit = document.elementFromPoint(x,y);
            if (hit !== node && !node.contains(hit)) throw new Error('Click target is covered');
            window.settingsNativeClick = null;
            document.addEventListener('click', event => {
                window.settingsNativeClick = {trusted:event.isTrusted, intended:node.contains(event.target), actual:event.target.textContent.trim()};
            }, {once:true,capture:true});
            return {x,y};
        })()`)) as { x: number; y: number }
        await page.call("Input.dispatchMouseEvent", {
            type: "mousePressed",
            ...point,
            button: "left",
            clickCount: 1,
        })
        await page.call("Input.dispatchMouseEvent", {
            type: "mouseReleased",
            ...point,
            button: "left",
            clickCount: 1,
        })
        expect(await page.evaluate("window.settingsNativeClick")).toMatchObject({
            trusted: true,
            intended: true,
        })
    }

    async function type(page: BrowserPage, expression: string, text: string) {
        await click(page, expression)
        await page.call("Input.dispatchKeyEvent", {
            type: "keyDown",
            key: "a",
            code: "KeyA",
            windowsVirtualKeyCode: 65,
            modifiers: 2,
        })
        await page.call("Input.dispatchKeyEvent", {
            type: "keyUp",
            key: "a",
            code: "KeyA",
            windowsVirtualKeyCode: 65,
            modifiers: 2,
        })
        await page.call("Input.insertText", { text })
    }

    async function choose(page: BrowserPage, name: string, index: number) {
        await click(page, fieldExpression(name))
        await key(page, "Home")
        for (let count = 0; count < index; count++) await key(page, "ArrowDown")
        await key(page, "Enter")
        await key(page, "Tab")
    }

    async function assertFocusedHeading(page: BrowserPage, name: string) {
        await page.waitFor(`(() => {
            const active = document.activeElement;
            const rect = active.getBoundingClientRect();
            return active.matches('h1,h2,h3,h4,h5,h6,[role="heading"]') &&
                rect.width > 0 && rect.height > 0 && getComputedStyle(active).visibility === 'visible';
        })()`)
        const accessibility = (await page.call("Accessibility.getFullAXTree")) as unknown as {
            nodes: {
                role?: { value: string }
                name?: { value: string }
                properties?: { name: string; value: { value: unknown } }[]
            }[]
        }
        expect(
            accessibility.nodes.some(
                (node) =>
                    node.role?.value === "heading" &&
                    node.name?.value === name &&
                    node.properties?.some(
                        (property) => property.name === "focused" && property.value.value === true,
                    ),
            ),
        ).toBe(true)
    }

    async function resizeViewport(page: BrowserPage, width: number) {
        await page.call("Emulation.setDeviceMetricsOverride", {
            width,
            height: 844,
            deviceScaleFactor: 1,
            mobile: false,
        })
    }

    async function setup(page: BrowserPage, width: number) {
        await page.call("Emulation.setDeviceMetricsOverride", {
            width,
            height: width === 1280 ? 900 : 844,
            deviceScaleFactor: 1,
            mobile: width === 390,
        })
        await page.call("Page.navigate", { url: `${origin}/en` })
        await page.waitFor("!!document.querySelector('[data-settings-trigger]')")
    }

    async function synthetic(page: BrowserPage, databaseName?: string) {
        await page.evaluate("window.dispatchEvent(new PageTransitionEvent('pagehide'))")
        await page.waitFor(
            "!document.querySelector('#app-root') && navigator.locks.query().then(result => result.held.every(lock => !lock.name.endsWith(':writer')))",
        )
        await page.evaluate(`(async () => {
            const {mountSettingsBrowserRoute} = await import('/tests/helpers/settings-browser-route.ts');
            const target = document.createElement('div'); document.body.append(target);
            window.settingsFixture = await mountSettingsBrowserRoute(target, ${JSON.stringify(databaseName)});
        })()`)
        await page.waitFor("!!document.querySelector('[data-settings-trigger]')")
    }

    async function open(page: BrowserPage) {
        await click(page, "document.querySelector('[data-settings-trigger]')")
        await page.waitFor(
            `document.activeElement === document.querySelector(${JSON.stringify(search)})`,
        )
    }

    async function guardedEscape(page: BrowserPage) {
        // Shared Modal intentionally blurs an interactive control on the first Escape.
        // Start from native keyboard focus instead of sending two Escapes from body,
        // which can open then immediately cancel a newly mounted confirmation.
        await key(page, "Tab")
        // A draggable desktop header adds a focusable toolbar before the controls.
        if (await page.evaluate("document.activeElement.matches('[role=toolbar]')"))
            await key(page, "Tab")
        expect(
            await page.evaluate(
                "!!document.activeElement.closest('[role=dialog]') && document.activeElement.matches('button,input,select')",
            ),
        ).toBe(true)
        await key(page, "Escape")
        await page.waitFor("document.activeElement === document.body")
        expect(await page.evaluate("document.querySelector('[role=alertdialog]') === null")).toBe(
            true,
        )
        await key(page, "Escape")
        await page.waitFor("!!document.activeElement.closest('[role=alertdialog]:not([inert])')")
    }

    async function assertTabTrap(page: BrowserPage, selector: string) {
        const count = (await page.evaluate(
            `Array.from(document.querySelectorAll(${JSON.stringify(`${selector} button, ${selector} input, ${selector} select`)})).filter(node => !node.disabled && node.getBoundingClientRect().width > 0).length`,
        )) as number
        expect(count).toBeGreaterThan(2)
        const visited = new Set<string>()
        for (const shift of [false, true]) {
            for (let index = 0; index < count + 2; index++) {
                await key(page, "Tab", shift)
                const state = (await page.evaluate(`(() => {
                    const active = document.activeElement;
                    const style = getComputedStyle(active);
                    return {inside: !!active.closest(${JSON.stringify(selector)}),
                        identity: active.id || active.getAttribute('aria-label') || active.textContent.trim(),
                        visibleFocus: active.matches(':focus-visible') && style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) >= 2 && style.outlineColor !== style.backgroundColor};
                })()`)) as { inside: boolean; identity: string; visibleFocus: boolean }
                expect(state.inside).toBe(true)
                expect(state.visibleFocus).toBe(true)
                visited.add(state.identity)
            }
        }
        expect(visited.size).toBeGreaterThanOrEqual(count)
    }

    async function openReading(page: BrowserPage) {
        await click(page, buttonExpression("Plugins"))
        await click(page, buttonExpression("Reading", `${dialog} section`))
    }

    async function finish(page: BrowserPage) {
        try {
            await page.evaluate(
                "(async () => { await window.settingsFixture?.stop(); window.dispatchEvent(new PageTransitionEvent('pagehide')); })()",
            )
        } finally {
            await browser!.closeTarget(page.targetId)
        }
    }

    it.each([1280, 390])(
        "opens singleton Settings with native Ctrl+, from the header and an input at %ipx",
        async (width) => {
            const page = await browser!.page()
            const shortcut = async () => {
                for (const type of ["keyDown", "keyUp"]) {
                    await page.call("Input.dispatchKeyEvent", {
                        type,
                        key: ",",
                        code: "Comma",
                        windowsVirtualKeyCode: 188,
                        modifiers: 2,
                    })
                }
            }
            try {
                await setup(page, width)
                expect(
                    await page.evaluate(`(() => {
                    const trigger = document.querySelector('header [data-settings-trigger]');
                    const rect = trigger.getBoundingClientRect();
                    const actions = trigger.closest('.header-btn-wrapper');
                    return !document.querySelector('.app-settings-access') &&
                        trigger.getAttribute('aria-label') === 'Settings' &&
                        trigger.getAttribute('aria-keyshortcuts') === 'Control+,' &&
                        rect.width >= 44 && rect.height >= 44 &&
                        getComputedStyle(trigger).borderRadius === '6px' &&
                        trigger.textContent.trim() === '' &&
                        actions.lastElementChild === trigger;
                })()`),
                ).toBe(true)
                await page.evaluate("document.querySelector('[data-settings-trigger]').focus()")
                await shortcut()
                await page.waitFor(
                    `document.activeElement === document.querySelector(${JSON.stringify(search)})`,
                )
                await type(page, `document.querySelector(${JSON.stringify(search)})`, "Theme")
                await page.evaluate("window.shortcutSearch = document.activeElement")
                await shortcut()
                expect(
                    await page.evaluate(`document.querySelectorAll('[role=dialog]').length === 1 &&
                    document.activeElement === window.shortcutSearch && window.shortcutSearch.value === 'Theme'`),
                ).toBe(true)
                await click(page, `document.querySelector(${JSON.stringify(close)})`)
                await page.waitFor("!document.querySelector('[role=dialog]')")
                expect(
                    await page.evaluate(
                        "document.activeElement === document.querySelector('[data-settings-trigger]')",
                    ),
                ).toBe(true)
                // Test an input outside the modal without depending on unrelated library tools.
                await page.evaluate(`(() => {
                    const input = document.createElement('input');
                    input.id = 'shortcut-input'; input.value = 'keep';
                    document.querySelector('main').append(input); input.focus();
                })()`)
                await shortcut()
                await page.waitFor(
                    `document.activeElement === document.querySelector(${JSON.stringify(search)})`,
                )
                expect(await page.evaluate("document.querySelector('#shortcut-input').value")).toBe(
                    "keep",
                )
                await click(page, `document.querySelector(${JSON.stringify(close)})`)
                await page.waitFor("!document.querySelector('[role=dialog]')")
                expect(await page.evaluate("document.activeElement.id")).toBe("shortcut-input")
                expect(page.errors).toEqual([])
            } finally {
                await finish(page)
            }
        },
        90000,
    )

    it.each([1280, 390])(
        "allows header dragging only for desktop Settings at %ipx",
        async (width) => {
            const page = await browser!.page()
            try {
                await setup(page, width)
                await open(page)
                await page.waitFor(
                    "document.getAnimations().every(animation => animation.playState !== 'running')",
                )
                const before = (await page.evaluate(`(() => {
                    const surface = document.querySelector('[role=dialog]');
                    const rect = surface.getBoundingClientRect();
                    const header = surface.querySelector('.modal-header').getBoundingClientRect();
                    return {left:rect.left, top:rect.top, x:header.left+header.width/2, y:header.top+header.height/2};
                })()`)) as { left: number; top: number; x: number; y: number }
                await page.call("Input.dispatchMouseEvent", {
                    type: "mouseMoved",
                    x: before.x,
                    y: before.y,
                })
                await page.call("Input.dispatchMouseEvent", {
                    type: "mousePressed",
                    x: before.x,
                    y: before.y,
                    button: "left",
                    clickCount: 1,
                })
                await page.call("Input.dispatchMouseEvent", {
                    type: "mouseMoved",
                    x: before.x + 64,
                    y: before.y + 40,
                    button: "left",
                    buttons: 1,
                })
                await page.call("Input.dispatchMouseEvent", {
                    type: "mouseReleased",
                    x: before.x + 64,
                    y: before.y + 40,
                    button: "left",
                    clickCount: 1,
                })
                expect(
                    await page.evaluate(`(() => {
                        const rect = document.querySelector('[role=dialog]').getBoundingClientRect();
                        return Math.abs(rect.left - ${before.left + (width === 1280 ? 64 : 0)}) < 1 &&
                            Math.abs(rect.top - ${before.top + (width === 1280 ? 40 : 0)}) < 1;
                    })()`),
                ).toBe(true)
                expect(
                    await page.evaluate(
                        "!!document.querySelector('[role=dialog] .modal-header.drag-handle')",
                    ),
                ).toBe(width === 1280)
                await type(page, `document.querySelector(${JSON.stringify(search)})`, "Theme")
                await page.waitFor(`!!${fieldExpression("Theme")}`)
                await click(page, `document.querySelector(${JSON.stringify(close)})`)
                await page.waitFor("!document.querySelector('[role=dialog]')")
                expect(page.errors).toEqual([])
            } finally {
                await finish(page)
            }
        },
        90000,
    )

    it.each([1280, 390])(
        "keeps Library and synthetic plugin Settings usable with native search, scrolling and Back at %ipx",
        async (width) => {
            const page = await browser!.page()
            try {
                await setup(page, width)
                await open(page)
                expect(
                    await page.evaluate(
                        `document.querySelectorAll(${JSON.stringify(dialog)}).length`,
                    ),
                ).toBe(1)
                await click(page, buttonExpression("Plugins"))
                await page.waitFor(`!!${buttonExpression("Reading", `${dialog} section`)}`)
                expect(
                    await page.evaluate(
                        "Array.from(document.querySelectorAll('[role=dialog] nav > ul > li > button')).map(node => node.textContent.trim())",
                    ),
                ).toEqual(["General", "Appearance", "Library", "Plugins"])
                await click(page, buttonExpression("Reading", `${dialog} section`))
                await assertFocusedHeading(page, "Reading")
                expect(
                    await page.evaluate(
                        "document.querySelectorAll('[role=dialog] article').length",
                    ),
                ).toBe(3)
                expect(await page.evaluate(`${fieldExpression("Default zoom")}.value`)).toBe("1.5")
                await click(page, "document.querySelector(" + JSON.stringify(close) + ")")
                await page.waitFor(`!document.querySelector(${JSON.stringify(dialog)})`)
                expect(
                    await page.evaluate(
                        "document.activeElement === document.querySelector('[data-settings-trigger]')",
                    ),
                ).toBe(true)
                await synthetic(page)
                await open(page)
                expect(
                    await page.evaluate(`(() => {
                const modal = document.querySelector(${JSON.stringify(dialog)});
                return document.getElementById(modal.getAttribute('aria-labelledby')).textContent.trim();
            })()`),
                ).toBe("Settings")
                const initialGeometry = await page.evaluate(`(() => {
                const modal = document.querySelector(${JSON.stringify(dialog)}).getBoundingClientRect();
                const nav = document.querySelector(${JSON.stringify(`${dialog} nav`)}).getBoundingClientRect();
                const pane = document.querySelector(${JSON.stringify(`${dialog} section`)}).getBoundingClientRect();
                return {fullscreen: Math.abs(modal.width-innerWidth)<2 && Math.abs(modal.height-innerHeight)<2,
                    sideBySide: nav.width > 100 && pane.width > 100 && nav.right <= pane.left + 2,
                    navVisible: nav.width > 0 && nav.height > 0, paneVisible: pane.width > 0 && pane.height > 0};
            })()`)
                expect(initialGeometry).toMatchObject(
                    width === 390
                        ? { fullscreen: true, navVisible: true, paneVisible: false }
                        : { sideBySide: true, navVisible: true, paneVisible: true },
                )
                // Plugins is still collapsed: global search must nevertheless find every editor.
                expect(
                    await page.evaluate(
                        `${buttonExpression("Plugins")}.getAttribute('aria-expanded')`,
                    ),
                ).toBe("false")
                await type(page, `document.querySelector(${JSON.stringify(search)})`, "Paper Tools")
                await page.waitFor(
                    "document.querySelectorAll('[role=dialog] article').length === 4",
                )
                expect(
                    await page.evaluate(
                        "Array.from(document.querySelectorAll('[role=dialog] article p:first-child')).every(node => node.textContent.includes('Plugins') && node.textContent.includes('Paper Tools'))",
                    ),
                ).toBe(true)
                expect(
                    await page.evaluate(
                        "document.querySelector('[role=dialog] article img, [role=dialog] article script') === null && !window.metadataExecuted",
                    ),
                ).toBe(true)
                expect(
                    await page.evaluate(
                        "document.querySelector('[role=dialog]').textContent.includes('<script>window.metadataExecuted=true</script>')",
                    ),
                ).toBe(true)
                // Native wheel scroll reveals the lower controls beneath a deliberately long description.
                const pane = (await page.evaluate(
                    "(() => { const r=document.querySelector('[role=dialog] section').getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2}; })()",
                )) as { x: number; y: number }
                await page.call("Input.dispatchMouseEvent", {
                    type: "mouseWheel",
                    ...pane,
                    deltaX: 0,
                    deltaY: 650,
                })
                await page.waitFor("document.querySelector('[role=dialog] section').scrollTop > 0")
                for (const name of [
                    "Caption <img src=x onerror=window.metadataExecuted=true>",
                    "Count",
                    "Enabled",
                    "Mode",
                ]) {
                    const geometry = await page.evaluate(
                        `(() => { const node=${fieldExpression(name)}; node.scrollIntoView({block:'center',behavior:'instant'}); const r=node.getBoundingClientRect(); return {visible:r.width>0 && r.height>=24, bounded:r.left>=0 && r.right<=innerWidth+1 && r.top>=0 && r.bottom<=innerHeight+1, label:document.querySelector('label[for="'+node.id+'"]').textContent}; })()`,
                    )
                    expect(geometry).toMatchObject({ visible: true, bounded: true, label: name })
                }
                await click(page, fieldExpression("Enabled"))
                await page.waitFor(
                    "window.settingsFixture.host.settings.getValue('test.browser-options.enabled').then(value => value === true)",
                )
                await choose(page, "Mode", 1)
                expect(
                    await page.evaluate(
                        "window.settingsFixture.host.settings.getValue('test.browser-options.mode')",
                    ),
                ).toBe("two")
                await type(page, fieldExpression("Count"), "3")
                await key(page, "Tab")
                await page.waitFor(
                    `${fieldExpression("Count")}.getAttribute('aria-invalid') === 'true'`,
                )
                expect(
                    await page.evaluate(
                        "window.settingsFixture.host.settings.getValue('test.browser-options.count')",
                    ),
                ).toBe(2)
                await page.evaluate(`window.retainedField = ${fieldExpression("Count")}`)
                await page.evaluate("window.settingsFixture.host.commands.execute('settings.open')")
                await page.waitFor(
                    `document.activeElement === document.querySelector(${JSON.stringify(search)})`,
                )
                expect(
                    await page.evaluate(
                        `${fieldExpression("Count")} === window.retainedField && window.retainedField.value === '3' && document.querySelectorAll('[role=dialog]').length === 1`,
                    ),
                ).toBe(true)
                if (width === 390) {
                    await click(page, buttonExpression("Back"))
                    expect(
                        await page.evaluate(
                            "document.querySelector('[role=dialog] nav').getBoundingClientRect().width > 0 && document.querySelector('[role=dialog] section').getBoundingClientRect().width === 0",
                        ),
                    ).toBe(true)
                    await click(page, buttonExpression("Plugins"))
                    await click(
                        page,
                        buttonExpression(
                            "Paper Tools <img src=x onerror=window.metadataExecuted=true>",
                        ),
                    )
                    expect(await page.evaluate(`${fieldExpression("Count")}.value`)).toBe("3")
                    expect(await page.evaluate(`${fieldExpression("Enabled")}.checked`)).toBe(true)
                    expect(
                        await page.evaluate(
                            `${fieldExpression("Mode")}.selectedOptions[0].textContent`,
                        ),
                    ).toBe("Two")
                } else {
                    await click(page, buttonExpression("Plugins"))
                    await click(
                        page,
                        buttonExpression(
                            "Paper Tools <img src=x onerror=window.metadataExecuted=true>",
                            '[role="dialog"] nav',
                        ),
                    )
                    expect(await page.evaluate(`${fieldExpression("Count")}.value`)).toBe("3")
                    const navigationBounds = await page.evaluate(
                        "(() => {const nav=document.querySelector('[role=dialog] nav'); const plugin=Array.from(nav.querySelectorAll('button')).find(node => node.textContent.includes('Paper Tools')); return {noOverflow:nav.scrollWidth <= nav.clientWidth+1,markupAbsent:!nav.querySelector('img,script'),navWidth:nav.clientWidth,navScrollWidth:nav.scrollWidth,buttonWidth:plugin.clientWidth,buttonScrollWidth:plugin.scrollWidth,overflowWrap:getComputedStyle(plugin).overflowWrap};})()",
                    )
                    console.info("Settings long plugin navigation bounds:", navigationBounds)
                    expect(navigationBounds).toMatchObject({ noOverflow: true, markupAbsent: true })
                }
                await type(
                    page,
                    `document.querySelector(${JSON.stringify(search)})`,
                    "nothing matches this query",
                )
                await page.waitFor(
                    "document.querySelector('[role=dialog]').textContent.includes('No matching settings')",
                )
                await click(page, buttonExpression("Clear search"))
                expect(
                    await page.evaluate(`document.querySelector(${JSON.stringify(search)}).value`),
                ).toBe("")
                expect(
                    await page.evaluate(
                        "document.documentElement.scrollWidth <= innerWidth && document.querySelector('[role=dialog]').scrollWidth <= document.querySelector('[role=dialog]').clientWidth+1",
                    ),
                ).toBe(true)
                await type(
                    page,
                    `document.querySelector(${JSON.stringify(search)})`,
                    "Even values from zero to ten",
                )
                await page.waitFor(
                    "document.querySelectorAll('[role=dialog] article').length === 1",
                )
                expect(await page.evaluate(`${fieldExpression("Count")}.value`)).toBe("3")
                await click(page, buttonExpression("Clear search"))
                console.info(`Settings geometry ${width}:`, initialGeometry)
                expect(page.errors).toEqual([])
            } finally {
                await finish(page)
            }
        },
        90000,
    )

    it("returns keyboard Back focus to the selected mobile navigation without losing an invalid attempt", async () => {
        const page = await browser!.page()
        try {
            await setup(page, 390)
            await synthetic(page)
            await open(page)
            await page.evaluate(`${buttonExpression("Plugins")}.focus()`)
            await key(page, "Enter")
            await assertFocusedHeading(page, "Plugins")
            await page.evaluate(`${buttonExpression("Reading", `${dialog} section`)}.focus()`)
            await key(page, "Enter")
            await assertFocusedHeading(page, "Reading")
            await type(page, fieldExpression("Default zoom"), "99")
            await key(page, "Tab")
            await page.waitFor(
                `${fieldExpression("Default zoom")}.getAttribute('aria-invalid') === 'true'`,
            )
            await page.evaluate(`${buttonExpression("Back")}.focus()`)
            await key(page, "Enter")
            await page.waitFor(
                "document.querySelector('[role=dialog] nav').getBoundingClientRect().width > 0",
            )
            expect(
                await page.evaluate(`document.activeElement === ${buttonExpression("Reading")}`),
            ).toBe(true)
            await key(page, "Enter")
            await assertFocusedHeading(page, "Reading")
            expect(await page.evaluate(`${fieldExpression("Default zoom")}.value`)).toBe("99")
            expect(
                await page.evaluate(
                    `${fieldExpression("Default zoom")}.getAttribute('aria-invalid')`,
                ),
            ).toBe("true")
            expect(await page.evaluate("document.querySelectorAll('[role=dialog]').length")).toBe(1)
            expect(page.errors).toEqual([])
        } finally {
            await finish(page)
        }
    }, 90000)

    it.each(["navigation", "page"])(
        "recovers responsive hidden %s focus inside the same Settings",
        async (region) => {
            const page = await browser!.page()
            const resize = (width: number) => resizeViewport(page, width)
            try {
                await setup(page, 1280)
                await synthetic(page)
                await open(page)
                if (region === "navigation") {
                    await openReading(page)
                    await type(page, fieldExpression("Default zoom"), "99")
                    await key(page, "Tab")
                    await page.waitFor(
                        `${fieldExpression("Default zoom")}.getAttribute('aria-invalid') === 'true'`,
                    )
                    await page.evaluate(`${buttonExpression("Reading")}.focus()`)
                } else {
                    // The initial desktop page is visible even before entering drill-down.
                    await page.evaluate(`${fieldExpression("Language")}.focus()`)
                }
                await resize(801)
                expect(
                    await page.evaluate("document.activeElement.getClientRects().length > 0"),
                ).toBe(true)
                await resize(800)
                await page.waitFor(
                    region === "navigation"
                        ? "document.querySelector('[role=dialog] nav').getClientRects().length === 0"
                        : "document.querySelector('[role=dialog] section').getClientRects().length === 0",
                )
                await page.waitFor(
                    "document.activeElement !== document.body && !!document.activeElement.closest('[role=dialog]:not([inert])') && document.activeElement.getClientRects().length > 0",
                )
                if (region === "navigation") {
                    await assertFocusedHeading(page, "Reading")
                } else {
                    expect(
                        await page.evaluate(
                            `document.activeElement === ${buttonExpression("General")}`,
                        ),
                    ).toBe(true)
                }
                await resize(390)
                if (region === "navigation") {
                    expect(await page.evaluate(`${fieldExpression("Default zoom")}.value`)).toBe(
                        "99",
                    )
                    expect(
                        await page.evaluate(
                            `${fieldExpression("Default zoom")}.getAttribute('aria-invalid')`,
                        ),
                    ).toBe("true")
                    await page.evaluate(`${buttonExpression("Back")}.focus()`)
                    await resize(1280)
                    await assertFocusedHeading(page, "Reading")
                }
                expect(
                    await page.evaluate("document.querySelectorAll('[role=dialog]').length"),
                ).toBe(1)
                expect(page.errors).toEqual([])
            } finally {
                await finish(page)
            }
        },
        90000,
    )

    it("does not take responsive focus from a confirmation or replacement Prompt", async () => {
        const page = await browser!.page()
        const resize = (width: number) => resizeViewport(page, width)
        try {
            await setup(page, 1280)
            await synthetic(page)
            await open(page)
            await openReading(page)
            await type(page, fieldExpression("Default zoom"), "99")
            await key(page, "Tab")
            await click(page, `document.querySelector(${JSON.stringify(close)})`)
            await page.waitFor(
                "!!document.activeElement.closest('[role=alertdialog]:not([inert])')",
            )
            await page.evaluate("window.retainedFocus = document.activeElement")
            await resize(390)
            expect(
                await page.evaluate(
                    "document.activeElement === window.retainedFocus && !!document.activeElement.closest('[role=alertdialog]:not([inert])')",
                ),
            ).toBe(true)
            await click(page, buttonExpression("Stay", '[role="alertdialog"]'))
            await page.waitFor("!document.querySelector('[role=alertdialog]')")
            await resize(1280)
            await page.evaluate(`${buttonExpression("Reading")}.focus()`)
            await page.evaluate(`(async () => {
                const {openCommandPalette} = await import('/src/lib/extensions/builtin/prompt/index.ts');
                window.settingsReplacement = openCommandPalette(undefined, 'Open Settings');
            })()`)
            await page.waitFor(
                "document.activeElement.tagName === 'INPUT' && document.activeElement.closest('[role=dialog]')?.textContent.includes('Open Settings')",
            )
            await page.evaluate("window.retainedFocus = document.activeElement")
            await resize(390)
            expect(
                await page.evaluate(
                    "document.activeElement === window.retainedFocus && !document.activeElement.closest('[inert]') && document.activeElement.getClientRects().length > 0",
                ),
            ).toBe(true)
            expect(page.errors).toEqual([])
        } finally {
            await finish(page)
        }
    }, 90000)

    it.each([1280, 390])(
        "contains native keyboard focus, guards Escape and restores the opener at %ipx",
        async (width) => {
            const page = await browser!.page()
            try {
                await setup(page, width)
                await synthetic(page)
                await open(page)
                await type(page, `document.querySelector(${JSON.stringify(search)})`, "Count")
                await page.waitFor(`${fieldExpression("Count")}.value === '2'`)
                const accessibility = (await page.call(
                    "Accessibility.getFullAXTree",
                )) as unknown as { nodes: { role?: { value: string }; name?: { value: string } }[] }
                expect(
                    accessibility.nodes.some(
                        (node) => node.role?.value === "dialog" && node.name?.value === "Settings",
                    ),
                ).toBe(true)
                expect(
                    accessibility.nodes.some(
                        (node) => node.role?.value === "spinbutton" && node.name?.value === "Count",
                    ),
                ).toBe(true)
                await assertTabTrap(page, dialog)
                await type(page, fieldExpression("Count"), "3")
                await key(page, "Tab")
                await page.waitFor(
                    `${fieldExpression("Count")}.getAttribute('aria-invalid') === 'true'`,
                )
                expect(
                    await page.evaluate(
                        `(() => {const node=${fieldExpression("Count")}; return node.getAttribute('aria-describedby').split(' ').some(id => document.getElementById(id)?.textContent.includes('Enter a valid value within the declared limits.'));})()`,
                    ),
                ).toBe(true)
                await guardedEscape(page)
                await assertTabTrap(page, '[role="alertdialog"]')
                await page.evaluate("window.settingsFixture.host.commands.execute('settings.open')")
                expect(
                    await page.evaluate("!!document.activeElement.closest('[role=alertdialog]')"),
                ).toBe(true)
                await click(page, buttonExpression("Stay", '[role="alertdialog"]'))
                await page.waitFor("!document.querySelector('[role=alertdialog]')")
                expect(await page.evaluate(`${fieldExpression("Count")}.value`)).toBe("3")
                await guardedEscape(page)
                await click(page, buttonExpression("Discard unsaved edits", '[role="alertdialog"]'))
                await page.waitFor("!document.querySelector('[role=dialog], [role=alertdialog]')")
                expect(
                    await page.evaluate(
                        "document.activeElement === document.querySelector('[data-settings-trigger]')",
                    ),
                ).toBe(true)
                expect(
                    await page.evaluate(
                        "window.settingsFixture.host.settings.getValue('test.browser-options.count')",
                    ),
                ).toBe(2)
                expect(page.errors).toEqual([])
            } finally {
                await finish(page)
            }
        },
        90000,
    )

    it.each([1280, 390])(
        "applies live theme and motion with reduced motion, forced colors and usable safe-area bounds at %ipx",
        async (width) => {
            const page = await browser!.page()
            const media = (scheme: string, forced = "none") =>
                page.call("Emulation.setEmulatedMedia", {
                    features: [
                        { name: "prefers-reduced-motion", value: "reduce" },
                        { name: "prefers-color-scheme", value: scheme },
                        { name: "forced-colors", value: forced },
                    ],
                })
            try {
                await media("light")
                await setup(page, width)
                await synthetic(page)
                await open(page)
                await click(page, buttonExpression("Appearance"))
                await page.waitFor(`${fieldExpression("Animations")}.type === 'checkbox'`)
                expect(
                    await page.evaluate(
                        "matchMedia('(prefers-reduced-motion: reduce)').matches && document.documentElement.dataset.motion === 'off'",
                    ),
                ).toBe(true)
                expect(
                    await page.evaluate(
                        `!${fieldExpression("Animations")}.checked && getComputedStyle(document.body).transitionDuration.split(',').every(value => parseFloat(value) < 0.001)`,
                    ),
                ).toBe(true)
                await click(page, fieldExpression("Animations"))
                await page.waitFor("document.documentElement.dataset.motion === 'on'")
                expect(
                    await page.evaluate(
                        "getComputedStyle(document.body).transitionDuration.split(',').some(value => parseFloat(value) > 0.01)",
                    ),
                ).toBe(true)
                await click(page, fieldExpression("Animations"))
                await page.waitFor("document.documentElement.dataset.motion === 'off'")
                await choose(page, "Theme", 1)
                await page.waitFor("document.documentElement.classList.contains('dark')")
                const darkColor = await page.evaluate(
                    "getComputedStyle(document.querySelector('[role=dialog] section')).color",
                )
                await choose(page, "Theme", 0)
                await page.waitFor("!document.documentElement.classList.contains('dark')")
                const lightColor = await page.evaluate(
                    "getComputedStyle(document.querySelector('[role=dialog] section')).color",
                )
                expect(darkColor).not.toBe(lightColor)
                await choose(page, "Theme", 2)
                await page.waitFor(
                    "(async () => await window.settingsFixture.host.settings.getValue('settings.theme') === 'system' && window.settingsFixture.host.settingsCapability.settingsStore.theme === 'system')()",
                )
                await media("dark")
                await page.waitFor("document.documentElement.classList.contains('dark')")
                await media("light")
                await page.waitFor("!document.documentElement.classList.contains('dark')")
                await type(page, `document.querySelector(${JSON.stringify(search)})`, "Count")
                await page.waitFor(`${fieldExpression("Count")}.value === '2'`)
                await type(page, fieldExpression("Count"), "3")
                await key(page, "Tab")
                await media("light", "active")
                await page.waitFor("matchMedia('(forced-colors: active)').matches")
                await assertTabTrap(page, dialog)
                const contrast = await page.evaluate(`(() => {
                const node = ${fieldExpression("Count")};
                const error = document.getElementById(node.getAttribute('aria-describedby').split(' ').find(id => id.endsWith('-error')));
                const style = getComputedStyle(error);
                const pane = document.querySelector('[role=dialog] section');
                const padding = getComputedStyle(pane);
                return {errorText:error.textContent.trim(), errorReadable:style.color !== getComputedStyle(pane).backgroundColor && style.visibility === 'visible',
                    borderVisible:getComputedStyle(node).borderTopStyle !== 'none' && parseFloat(getComputedStyle(node).borderTopWidth) >= 1,
                    noOverflow:document.documentElement.scrollWidth <= innerWidth && pane.scrollWidth <= pane.clientWidth + 1,
                    paddingLeft:parseFloat(padding.paddingLeft),paddingRight:parseFloat(padding.paddingRight),paddingBottom:parseFloat(padding.paddingBottom)};
            })()`)
                expect(contrast).toMatchObject({
                    errorText: "Enter a valid value within the declared limits.",
                    errorReadable: true,
                    borderVisible: true,
                    noOverflow: true,
                })
                expect(contrast).toMatchObject({
                    paddingLeft: width === 390 ? 16 : 32,
                    paddingRight: width === 390 ? 16 : 32,
                    paddingBottom: 24,
                })
                for (const expression of [
                    `document.querySelector(${JSON.stringify(close)})`,
                    `document.querySelector(${JSON.stringify(search)})`,
                    ...(width === 390 ? [buttonExpression("Back")] : []),
                ]) {
                    expect(
                        await page.evaluate(
                            `(() => {const node=${expression}; const r=node.getBoundingClientRect(); const hit=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);return r.width>0 && r.height>=32 && r.left>=0 && r.top>=0 && r.right<=innerWidth+1 && r.bottom<=innerHeight+1 && (node===hit || node.contains(hit));})()`,
                        ),
                    ).toBe(true)
                }
                console.info(`Settings forced-color/safe-area inspection ${width}:`, contrast)
                expect(page.errors).toEqual([])
            } finally {
                await finish(page)
            }
        },
        90000,
    )

    it.each([1280, 390])(
        "opens from the native Command palette selection and applies durable language navigation in the real Library at %ipx",
        async (width) => {
            const page = await browser!.page()
            try {
                await setup(page, width)
                await page.evaluate(`(async () => {
                const {openCommandPalette} = await import('/src/lib/extensions/builtin/prompt/index.ts');
                window.settingsPalette = openCommandPalette(undefined, 'Open Settings');
            })()`)
                await page.waitFor(
                    "document.activeElement?.tagName === 'INPUT' && document.querySelector('[role=dialog]')?.textContent.includes('Open Settings')",
                )
                await key(page, "Enter")
                await page.waitFor(
                    `!!document.querySelector('[role=dialog] nav[aria-label=Settings]') && document.activeElement === document.querySelector(${JSON.stringify(search)}) && document.querySelectorAll('[role=dialog]').length === 1`,
                )
                await click(page, buttonExpression("General"))
                await choose(page, "Language", 1)
                await page.waitFor("document.documentElement.lang === 'en'")
                const beforeRussian = await page.evaluate("performance.timeOrigin")
                await choose(page, "Language", 0)
                await page.waitFor(
                    `performance.timeOrigin !== ${beforeRussian} && location.pathname === '/' && !!document.querySelector('[data-settings-trigger]')`,
                )
                expect(await page.evaluate("document.documentElement.lang")).toBe("ru")
                await click(page, "document.querySelector('[data-settings-trigger]')")
                await page.waitFor("!!document.querySelector('[role=dialog]')")
                await click(page, buttonExpression("Основные"))
                await page.waitFor("document.querySelector('[role=dialog] select')?.value === '0'")
                expect(await page.evaluate(`${fieldExpression("Язык")}.value`)).toBe("0")
                expect(
                    await page.evaluate("document.querySelector('[role=dialog]').textContent"),
                ).toContain("Поиск настроек")
                const beforeReload = await page.evaluate("performance.timeOrigin")
                await page.call("Page.reload")
                await page.waitFor(
                    `performance.timeOrigin !== ${beforeReload} && !!document.querySelector('[data-settings-trigger]')`,
                )
                await click(page, "document.querySelector('[data-settings-trigger]')")
                await page.waitFor("!!document.querySelector('[role=dialog]')")
                await click(page, buttonExpression("Основные"))
                await page.waitFor("document.querySelector('[role=dialog] select')?.value === '0'")
                expect(await page.evaluate(`${fieldExpression("Язык")}.value`)).toBe("0")
                const beforeEnglish = await page.evaluate("performance.timeOrigin")
                await choose(page, "Язык", 1)
                await page.waitFor(
                    `performance.timeOrigin !== ${beforeEnglish} && location.pathname === '/en' && !!document.querySelector('[data-settings-trigger]')`,
                )
                expect(await page.evaluate("document.documentElement.lang")).toBe("en")
                expect(page.errors).toEqual([])
            } finally {
                await finish(page)
            }
        },
        90000,
    )

    it("guards native language navigation with an invalid draft, held unrelated write, Stay and later Discard", async () => {
        const page = await browser!.page()
        try {
            await setup(page, 1280)
            await synthetic(page)
            await page.evaluate(
                "window.settingsFixture.host.settings.setValue('settings.language', 'en')",
            )
            await open(page)
            const before = await page.evaluate("performance.timeOrigin")
            const databaseName = (await page.evaluate(
                "window.settingsFixture.databaseName",
            )) as string
            await openReading(page)
            await page.waitFor(`${fieldExpression("Default zoom")}.value === '1.5'`)
            await type(page, fieldExpression("Default zoom"), "99")
            await key(page, "Tab")
            await page.waitFor(
                `${fieldExpression("Default zoom")}.getAttribute('aria-invalid') === 'true'`,
            )
            await page.evaluate(`(() => {
                const backend = window.settingsFixture.backend;
                const set = backend.set.bind(backend);
                backend.set = async (key, value) => {
                    if (key.endsWith(':settings.quality')) await new Promise(resolve => window.releaseLanguageCompanionWrite = resolve);
                    return set(key, value);
                };
                window.languageCompanionWrite = window.settingsFixture.host.commands.execute('settings.quality.in');
            })()`)
            await page.waitFor("typeof window.releaseLanguageCompanionWrite === 'function'")
            await click(page, buttonExpression("General"))
            await choose(page, "Language", 0)
            await page.waitFor("document.documentElement.lang === 'ru'")
            expect(await page.evaluate("location.pathname")).toBe("/en")
            expect(await page.evaluate("performance.timeOrigin")).toBe(before)
            expect(
                await page.evaluate("document.querySelector('[role=alertdialog]') === null"),
            ).toBe(true)
            expect(
                await page.evaluate(
                    "window.settingsFixture.host.settings.getValue('settings.language')",
                ),
            ).toBe("ru")
            await page.evaluate(
                "window.releaseLanguageCompanionWrite(); window.languageCompanionWrite",
            )
            await page.waitFor(
                "!!document.activeElement.closest('[role=alertdialog]:not([inert])')",
            )
            await click(page, buttonExpression("Stay", '[role="alertdialog"]'))
            await page.waitFor("!document.querySelector('[role=alertdialog]')")
            expect(await page.evaluate("performance.timeOrigin")).toBe(before)
            await openReading(page)
            await page.waitFor(
                "document.querySelector('[role=dialog] input[type=number]')?.value === '99'",
            )
            expect(
                await page.evaluate(
                    "window.settingsFixture.host.settings.getValue('settings.quality')",
                ),
            ).toBe(4)
            await click(page, `document.querySelector(${JSON.stringify(close)})`)
            await page.waitFor(
                "!!document.activeElement.closest('[role=alertdialog]:not([inert])')",
            )
            await click(page, buttonExpression("Discard unsaved edits", '[role="alertdialog"]'))
            await page.waitFor(
                `performance.timeOrigin !== ${before} && location.pathname === '/' && !!document.querySelector('[data-settings-trigger]')`,
            )
            // Recreate the same real-host fixture/database after document navigation;
            // the normal Library host uses a different database and may have its own locale.
            await synthetic(page, databaseName)
            await page.waitFor("document.documentElement.lang === 'ru'")
            expect(
                await page.evaluate(
                    "window.settingsFixture.host.settings.getValue('settings.language')",
                ),
            ).toBe("ru")
            expect(
                await page.evaluate(
                    "window.settingsFixture.host.settings.getValue('settings.quality')",
                ),
            ).toBe(4)
            expect(await page.evaluate("location.pathname")).toBe("/")
            expect(page.errors).toEqual([])
        } finally {
            await finish(page)
        }
    }, 90000)

    it.each(["plugin page", "search result"])(
        "recovers valid narrow navigation when an edited %s disappears",
        async (surface) => {
            const page = await browser!.page()
            const plugin = "Paper Tools <img src=x onerror=window.metadataExecuted=true>"
            try {
                await setup(page, 390)
                await synthetic(page)
                await open(page)
                await click(page, buttonExpression("Plugins"))
                await click(page, buttonExpression(plugin))
                await type(page, fieldExpression("Count"), "8")
                await key(page, "Tab")
                await page.waitFor(
                    "window.settingsFixture.host.settings.getValue('test.browser-options.count').then(value => value === 8)",
                )
                if (surface === "search result") {
                    await type(page, `document.querySelector(${JSON.stringify(search)})`, "Count")
                }
                await type(page, fieldExpression("Count"), "3")
                await key(page, "Tab")
                await page.waitFor(
                    `${fieldExpression("Count")}.getAttribute('aria-invalid') === 'true'`,
                )
                await page.evaluate("window.settingsFixture.host.disable('test.browser-options')")
                await page.waitFor(
                    "!document.querySelector('[role=dialog] article') && document.querySelector('[role=dialog]').textContent.includes('unsaved edits were discarded')",
                )
                expect(
                    await page.evaluate(
                        "document.querySelector('[role=dialog] section').textContent",
                    ),
                ).toContain(surface === "search result" ? "No matching settings" : "Reading")
                await page.evaluate(`${buttonExpression("Back")}.focus()`)
                await key(page, "Enter")
                await page.waitFor(`document.activeElement === ${buttonExpression("Plugins")}`)
                await key(page, "Enter")
                await assertFocusedHeading(page, "Plugins")
                expect(
                    await page.evaluate(
                        "document.querySelector('[role=dialog] section').textContent",
                    ),
                ).toContain("Reading")
                await page.evaluate("window.settingsFixture.host.enable('test.browser-options')")
                expect(
                    await page.evaluate("document.querySelector('[role=dialog] article') === null"),
                ).toBe(true)
                await page.evaluate("window.settingsFixture.host.activate('test.browser-options')")
                await page.waitFor(`!!${buttonExpression(plugin)}`)
                await click(page, buttonExpression(plugin))
                await page.waitFor(
                    "document.querySelector('[role=dialog] article[aria-label=Count] input')?.value === '8'",
                )
                expect(
                    await page.evaluate(`${fieldExpression("Count")}.getAttribute('aria-invalid')`),
                ).toBe("false")
                expect(
                    await page.evaluate(
                        "window.settingsFixture.host.settings.getValue('test.browser-options.count')",
                    ),
                ).toBe(8)
                await click(page, buttonExpression("Back"))
                await click(page, buttonExpression("General"))
                await page.waitFor(`${fieldExpression("Language")}.getClientRects().length > 0`)
                expect(
                    await page.evaluate("document.querySelectorAll('[role=dialog]').length"),
                ).toBe(1)
                expect(page.errors).toEqual([])
            } finally {
                await finish(page)
            }
        },
        90000,
    )

    it("retains a narrow search Reset through pending Back, failure, Stay, clear, Retry and reconstruction", async () => {
        const page = await browser!.page()
        const plugin = "Paper Tools <img src=x onerror=window.metadataExecuted=true>"
        const countRow = `document.querySelector('[role=dialog] article[aria-label="Count"]')`
        const reset = buttonExpression(
            "Reset to default",
            '[role="dialog"] article[aria-label="Count"]',
        )
        const failedReset = `${fieldExpression("Count")}.value === '2' && ${countRow}.textContent.includes('Not saved') && ${countRow}.textContent.includes('Modified')`
        const resize = async (width: number) => {
            await resizeViewport(page, width)
            // Wait for the real Modal presentation before measuring native pointer targets.
            await page.waitFor(`(() => {
                const rect = document.querySelector('[role=dialog]').getBoundingClientRect();
                return innerWidth === ${width} && (${width} === 390
                    ? Math.abs(rect.width-innerWidth)<2 && Math.abs(rect.height-innerHeight)<2
                    : rect.width < innerWidth);
            })()`)
            await page.waitFor(`(() => {
                const node = document.querySelector(${JSON.stringify(search)});
                const rect = node.getBoundingClientRect();
                return document.elementFromPoint(rect.left+rect.width/2, rect.top+rect.height/2) === node;
            })()`)
        }
        try {
            await setup(page, 390)
            await synthetic(page)
            const databaseName = (await page.evaluate(
                "window.settingsFixture.databaseName",
            )) as string
            await open(page)
            await type(page, `document.querySelector(${JSON.stringify(search)})`, "Enabled")
            await click(page, fieldExpression("Enabled"))
            await page.waitFor(
                "window.settingsFixture.host.settings.getValue('test.browser-options.enabled').then(value => value === true)",
            )
            await type(page, `document.querySelector(${JSON.stringify(search)})`, "Count")
            await type(page, fieldExpression("Count"), "8")
            await key(page, "Tab")
            await page.waitFor(
                `${countRow}.textContent.includes('Modified') && !${countRow}.querySelector('[role=status]')`,
            )
            expect(
                await page.evaluate(
                    "window.settingsFixture.host.settings.getValue('test.browser-options.count')",
                ),
            ).toBe(8)
            await page.evaluate(`(() => {
                const backend = window.settingsFixture.backend;
                window.originalSettingsSet = backend.set.bind(backend);
                backend.set = async (key, value) => {
                    if (key.endsWith(':test.browser-options.count') && value === 2) {
                        await new Promise(resolve => window.releaseSettingsReset = resolve);
                        throw new Error('private reset diagnostic');
                    }
                    return window.originalSettingsSet(key, value);
                };
            })()`)
            await click(page, reset)
            await page.waitFor(
                `typeof window.releaseSettingsReset === 'function' && ${countRow}.textContent.includes('Saving') && ${countRow}.textContent.includes('Modified')`,
            )
            await page.evaluate(`${buttonExpression("Back")}.focus()`)
            await key(page, "Enter")
            await page.waitFor(`document.activeElement === ${buttonExpression("General")}`)
            await click(page, buttonExpression("Plugins"))
            await click(page, buttonExpression(plugin))
            expect(await page.evaluate(`${fieldExpression("Count")}.value`)).toBe("2")
            expect(await page.evaluate(`${countRow}.textContent`)).toContain("Saving")
            expect(await page.evaluate(`${countRow}.textContent`)).toContain("Modified")
            await resize(1280)
            await page.evaluate(`${buttonExpression(plugin, '[role="dialog"] nav')}.focus()`)
            await resize(390)
            await assertFocusedHeading(page, plugin)
            expect(
                await page.evaluate(
                    `${fieldExpression("Count")}.value === '2' && ${countRow}.textContent.includes('Saving') && ${countRow}.textContent.includes('Modified')`,
                ),
            ).toBe(true)
            await page.waitFor(`(() => {
                const modal = document.querySelector('[role=dialog]').getBoundingClientRect();
                const node = document.querySelector(${JSON.stringify(close)});
                const rect = node.getBoundingClientRect();
                return Math.abs(modal.width-innerWidth)<2 && Math.abs(modal.height-innerHeight)<2 &&
                    node.contains(document.elementFromPoint(rect.left+rect.width/2, rect.top+rect.height/2));
            })()`)
            await click(page, `document.querySelector(${JSON.stringify(close)})`)
            await page.waitFor("document.querySelector('[aria-busy=true]') !== null")
            expect(
                await page.evaluate("document.querySelector('[role=alertdialog]') === null"),
            ).toBe(true)
            await page.evaluate("window.releaseSettingsReset()")
            await page.waitFor(
                "!!document.activeElement.closest('[role=alertdialog]:not([inert])')",
            )
            await click(page, buttonExpression("Stay", '[role="alertdialog"]'))
            await page.waitFor("!document.querySelector('[role=alertdialog]')")
            await resize(1280)
            await resize(390)
            expect(await page.evaluate(failedReset)).toBe(true)
            expect(
                await page.evaluate(
                    "window.settingsFixture.host.settings.getValue('test.browser-options.count')",
                ),
            ).toBe(8)
            expect(await page.evaluate("document.body.textContent")).not.toContain(
                "private reset diagnostic",
            )
            await type(page, `document.querySelector(${JSON.stringify(search)})`, "Count")
            expect(await page.evaluate(failedReset)).toBe(true)
            await click(page, buttonExpression("Clear search"))
            expect(await page.evaluate(failedReset)).toBe(true)
            await click(page, buttonExpression("Back"))
            expect(
                await page.evaluate(`document.activeElement === ${buttonExpression(plugin)}`),
            ).toBe(true)
            await click(page, buttonExpression(plugin))
            expect(await page.evaluate(failedReset)).toBe(true)
            await type(page, `document.querySelector(${JSON.stringify(search)})`, "Count")
            await page.evaluate("window.settingsFixture.backend.set = window.originalSettingsSet")
            await click(page, buttonExpression("Retry"))
            await page.waitFor(
                `!${countRow}.textContent.includes('Not saved') && !${countRow}.textContent.includes('Modified') && !${countRow}.textContent.includes('Saving')`,
            )
            expect(
                await page.evaluate(
                    "window.settingsFixture.host.settings.getValue('test.browser-options.count')",
                ),
            ).toBe(2)
            expect(
                await page.evaluate(
                    "window.settingsFixture.host.settings.getValue('test.browser-options.enabled')",
                ),
            ).toBe(true)
            await click(page, `document.querySelector(${JSON.stringify(close)})`)
            await page.waitFor("!document.querySelector('[role=dialog]')")
            await page.evaluate("window.settingsFixture.stop()")
            await synthetic(page, databaseName)
            await open(page)
            await type(page, `document.querySelector(${JSON.stringify(search)})`, "Count")
            await page.waitFor(`${fieldExpression("Count")}.value === '2'`)
            expect(await page.evaluate(`${countRow}.textContent.includes('Modified')`)).toBe(false)
            expect(
                await page.evaluate(
                    "window.settingsFixture.host.settings.getValue('test.browser-options.count')",
                ),
            ).toBe(2)
            expect(
                await page.evaluate(
                    "window.settingsFixture.host.settings.getValue('test.browser-options.enabled')",
                ),
            ).toBe(true)
            expect(page.errors).toEqual([])
        } finally {
            await finish(page)
        }
    }, 90000)

    it("keeps pending and failed attempts visible, waits on close and retries through real storage", async () => {
        const page = await browser!.page()
        try {
            await setup(page, 390)
            await synthetic(page)
            await open(page)
            await type(page, `document.querySelector(${JSON.stringify(search)})`, "Caption")
            await page.waitFor("!!document.querySelector('[role=dialog] article input[type=text]')")
            await page.evaluate(`(() => {
                const backend = window.settingsFixture.backend;
                window.originalSettingsSet = backend.set.bind(backend);
                backend.set = async (key, value) => {
                    if (key.endsWith(':test.browser-options.caption')) {
                        await new Promise(resolve => window.releaseSettingsWrite = resolve);
                        throw new Error('private storage diagnostic');
                    }
                    return window.originalSettingsSet(key, value);
                };
            })()`)
            await type(
                page,
                "document.querySelector('[role=dialog] article input[type=text]')",
                "attempted caption",
            )
            await key(page, "Tab")
            await page.waitFor("typeof window.releaseSettingsWrite === 'function'")
            await page.waitFor(
                "document.querySelector('[role=dialog] article [role=status]')?.textContent.includes('Saving')",
            )
            await click(page, `document.querySelector(${JSON.stringify(close)})`)
            await page.waitFor("document.querySelector('[aria-busy=true]') !== null")
            expect(
                await page.evaluate("document.querySelector('[role=alertdialog]') === null"),
            ).toBe(true)
            await page.evaluate("window.releaseSettingsWrite()")
            await page.waitFor("!!document.querySelector('[role=alertdialog]')")
            await click(page, buttonExpression("Stay", '[role="alertdialog"]'))
            await page.waitFor("!document.querySelector('[role=alertdialog]')")
            expect(
                await page.evaluate("document.querySelector('[role=dialog] article input').value"),
            ).toBe("attempted caption")
            expect(
                await page.evaluate(
                    "document.querySelector('[role=dialog] article [role=alert]').textContent",
                ),
            ).toContain("Not saved")
            expect(await page.evaluate("document.body.textContent")).not.toContain(
                "private storage diagnostic",
            )
            expect(
                await page.evaluate(
                    "window.settingsFixture.host.settings.getValue('test.browser-options.caption')",
                ),
            ).toBe("saved caption")
            await page.evaluate("window.settingsFixture.backend.set = window.originalSettingsSet")
            await click(page, buttonExpression("Retry"))
            await page.waitFor(
                "!document.querySelector('[role=dialog] article [role=alert]') && document.querySelector('[role=dialog] article').textContent.includes('Modified')",
            )
            expect(
                await page.evaluate(
                    "window.settingsFixture.host.settings.getValue('test.browser-options.caption')",
                ),
            ).toBe("attempted caption")
            await click(page, `document.querySelector(${JSON.stringify(close)})`)
            await page.waitFor("!document.querySelector('[role=dialog]')")
            await open(page)
            await type(page, `document.querySelector(${JSON.stringify(search)})`, "Caption")
            await page.waitFor(
                "document.querySelector('[role=dialog] article input')?.value === 'attempted caption'",
            )
            expect(page.errors).toEqual([])
        } finally {
            await finish(page)
        }
    }, 90000)
})
