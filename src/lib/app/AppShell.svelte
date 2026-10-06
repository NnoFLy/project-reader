<script lang="ts">
    import { settingsStore } from "$lib/modules/settings"
    import { onMount } from "svelte"
    import { searchStore, viewerStore } from "$lib/modules/viewer"
    import { vfsStore } from "$lib/modules/documents"
    import {
        type CommandScope,
        useCommands,
        commandsStore,
        KeyboardHandler,
    } from "$lib/modules/commands"
    import * as m from "$lib/paraglide/messages"
    import { KeymapHelp } from "$lib/modules/prompt"
    import { Prompt } from "$lib/modules/prompt"
    import {
        FloatingNotification,
        notificationStore,
        publishNotification,
        resolveContextualNotification,
    } from "$lib/modules/notifications"
    import { promptStore } from "$lib/modules/prompt"
    import { localizeHref } from "$lib/paraglide/runtime"
    import { page, updated } from "$app/state"
    import { afterNavigate, goto } from "$app/navigation"
    import { resolve } from "$app/paths"
    import { bookmarksStore } from "$lib/modules/viewer"
    import { settingsCommands } from "$lib/modules/settings"
    import { openCommandPalette } from "$lib/modules/prompt"
    import { createViewerOpenCommand } from "$lib/modules/viewer"
    import { createViewerBookmarkCommands } from "$lib/modules/viewer"
    import { safeStorageGet, safeStorageSet } from "$lib/shared/state/safeStorage"
    import {
        LibraryRelinkHost,
        libraryBookOpenCommand,
        requestLibraryRelink,
    } from "$lib/modules/library"
    import { appUpdate } from "$lib/shared/state/appUpdate.svelte"
    import "$lib/shared/styles/variables.css"
    import "$lib/shared/styles/typography.css"
    import "$lib/shared/styles/global.css"

    let { children } = $props()

    let rootNode: CommandScope = undefined as any

    let currentActiveNode = $derived(
        commandsStore.activeScope === rootNode ? null : commandsStore.activeScope,
    )
    let isHelpOpen = $state(false)
    let isViewerPage = $derived(page.url.pathname.includes("/viewer"))

    let contextualNotification = $derived(
        notificationStore.current ??
            resolveContextualNotification({
                isViewerPage,
                isLibrarySelectionActive: vfsStore.selectedIds.size > 0,
                selectedCount: vfsStore.selectedIds.size,
                isViewerSearchActive: searchStore.isActive,
                currentMatchIndex: searchStore.currentMatchIndex,
                matchCount: searchStore.matches.length,
                importCount: vfsStore.activeImportCount,
                selectedLabel: m.selected_label(),
                matchedLabel: m.matched_label(),
                importingLabel: m.importing_book().replace("...", "").trim().toUpperCase(),
            }),
    )

    const viewerOpenCommand = createViewerOpenCommand({
        onFileAccessFailure: ({ bookId }) => {
            const name = vfsStore.nodes[bookId]?.name ?? m.unknown_book()
            publishNotification({
                line1: m.file_open_failed(),
                line2: m.file_access_failure({ name }),
            })
            requestLibraryRelink(bookId, () =>
                commandsStore.execute("viewer.open", { bookId }).then(() => undefined),
            )
        },
    })

    const rootBookmarkCommands = createViewerBookmarkCommands({
        prompt: promptStore,
        scope: { onDestroy: (callback) => rootNode.onDestroy(callback) },
        bookmarks: {
            list: () => bookmarksStore.bookmarks,
            resolveBookName: (bookId) => vfsStore.nodes[bookId]?.name ?? m.unknown_book(),
            open: async (bookmarkId) => {
                const bookmark = bookmarksStore.bookmarks.find(({ id }) => id === bookmarkId)
                if (!bookmark) return
                const result = await commandsStore.execute("viewer.open", {
                    bookId: bookmark.bookId,
                })
                if (
                    result.status === "executed" &&
                    viewerStore.getCurrentBook()?.id === bookmark.bookId
                ) {
                    viewerStore.goToPage?.(bookmark.pageNumber, { isJump: true })
                }
            },
            isToggleBlocked: () => true,
            isCurrentPageBookmarked: () => false,
            toggleCurrentPage: () => undefined,
        },
    })

    rootNode = useCommands([
        {
            id: "prompt.open",
            keymap: ["ctrl+k", "shift+:", "alt+x"],
            label: () => m.keymap_prompt(),
            englishLabel: () => m.keymap_prompt({}, { locale: "en" }),
            allowInInputs: true,
            category: "commands",
            run: async (payload) => {
                if (promptStore.isOpen && payload?.initialQuery === undefined) {
                    promptStore.close()
                    return
                }
                await openCommandPalette(currentActiveNode || rootNode, payload?.initialQuery)
            },
        },
        { ...viewerOpenCommand, keymap: "shift+o" },
        libraryBookOpenCommand,
        rootBookmarkCommands["viewer.bookmark.open"],
        settingsCommands["settings.theme"],
        settingsCommands["settings.layout"],
        settingsCommands["settings.language"],
        settingsCommands["settings.animations.toggle"],
        settingsCommands["settings.pdf-title.toggle"],
        {
            id: "viewer.scroll.step",
            keymap: ["arrowdown", "j", "arrowup", "k"],
            label: () => m.keymap_scroll_step(),
            englishLabel: () => m.keymap_scroll_step({}, { locale: "en" }),
            category: "navigation",
            keyboardPayload: (event) => ({
                direction:
                    KeyboardHandler.resolveDirection(event, ["arrowup", "k"], ["arrowdown", "j"]) ??
                    "down",
                repeated: event.repeat,
            }),
            run: (payload) => {
                const { direction, repeated } = payload ?? {
                    direction: "down",
                    repeated: false,
                }
                window.scrollBy({
                    top: (direction === "up" ? -1 : 1) * window.innerHeight * 0.2,
                    behavior: !repeated && settingsStore.animations ? "smooth" : "auto",
                })
            },
        },
        {
            id: "viewer.scroll.half-page",
            keymap: ["pagedown", "d", "pageup", "u"],
            label: () => m.keymap_scroll_half_page(),
            englishLabel: () => m.keymap_scroll_half_page({}, { locale: "en" }),
            category: "navigation",
            keyboardPayload: (event) => ({
                direction:
                    KeyboardHandler.resolveDirection(event, ["pageup", "u"], ["pagedown", "d"]) ??
                    "down",
                repeated: event.repeat,
            }),
            run: (payload) => {
                const { direction, repeated } = payload ?? {
                    direction: "down",
                    repeated: false,
                }
                window.scrollBy({
                    top: (direction === "up" ? -1 : 1) * window.innerHeight * 0.5,
                    behavior: !repeated && settingsStore.animations ? "smooth" : "auto",
                })
            },
        },
        {
            id: "help.toggle",
            keymap: "?",
            label: () => m.keymap_toggle_help(),
            englishLabel: () => m.keymap_toggle_help({}, { locale: "en" }),
            category: "commands",
            run: () => {
                isHelpOpen = !isHelpOpen
            },
        },
    ])

    $effect(() => {
        settingsStore.updateDOM()
    })

    $effect(() => {
        if (updated.current) appUpdate.markAvailable()
    })

    afterNavigate(({ to }) => {
        if (!to) return
        const { pathname, search } = to.url
        if (
            pathname === "/" ||
            pathname === "/viewer" ||
            pathname === "/en" ||
            pathname === "/en/viewer"
        ) {
            safeStorageSet("last_visited_url", pathname + search)
        }
    })

    onMount(() => appUpdate.initialize())

    onMount(() => {
        const pathname = page.url.pathname as string
        const hasExplicitEn = pathname === "/en" || pathname.startsWith("/en/")

        // 1. URL locale is authoritative when landing on an explicitly localized URL
        if (hasExplicitEn && settingsStore.language !== "en") {
            settingsStore.language = "en"
        }

        // 2. Redirect to English if saved preference is English but URL is unprefixed (Russian base)
        if (settingsStore.language === "en" && !hasExplicitEn) {
            let targetHref = page.url.pathname + page.url.search + page.url.hash

            // Special case for root: try to restore last visited URL first
            if (page.url.pathname === "/" && page.url.search === "") {
                const lastVisitedUrl = safeStorageGet("last_visited_url")
                if (lastVisitedUrl && lastVisitedUrl !== "/") {
                    targetHref = lastVisitedUrl
                }
            }

            const localizedPath = localizeHref(targetHref, { locale: "en" })

            // Initialize VFS even when redirecting to avoid empty state during transition
            vfsStore.init().then(() => {
                if (vfsStore.initialized) void viewerStore.syncWithBooks()
            })

            window.location.replace(resolve(localizedPath as any))
            return
        }

        // 3. Normal initialization
        vfsStore.init().then(async () => {
            if (!vfsStore.initialized) return

            await viewerStore.syncWithBooks()
            await bookmarksStore.loadAllBookmarks()

            // Restore last visited URL if landing on the root page with no search params
            if (page.url.pathname === "/" && page.url.search === "") {
                const lastVisitedUrl = safeStorageGet("last_visited_url")
                if (lastVisitedUrl && lastVisitedUrl !== "/") {
                    const [p, s] = lastVisitedUrl.split("?")
                    const localizedPathname = localizeHref(p, {
                        locale: settingsStore.language,
                    })
                    const finalUrl = s ? `${localizedPathname}?${s}` : localizedPathname
                    goto(resolve(finalUrl as any), { replaceState: true })
                }
            }
        })

        const handleKeydown = (event: KeyboardEvent) => {
            const activeNode = currentActiveNode || rootNode
            activeNode.handleKeydown(event)
        }
        window.addEventListener("keydown", handleKeydown)
        return () => window.removeEventListener("keydown", handleKeydown)
    })
</script>

{#snippet modals()}
    {#if isHelpOpen}
        <KeymapHelp animations={settingsStore.animations} onClose={() => (isHelpOpen = false)} />
    {/if}
    {#if promptStore.isOpen}
        <Prompt />
    {/if}
{/snippet}

<div id="app-root">
    {#if isViewerPage}
        {@render children()}
        {@render modals()}
    {:else}
        <div class="app">
            {@render children()}
            {@render modals()}
        </div>
    {/if}

    <LibraryRelinkHost />

    <FloatingNotification
        notification={contextualNotification}
        animations={settingsStore.animations}
        viewerMode={isViewerPage}
    />
</div>
