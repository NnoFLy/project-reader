<script lang="ts">
    import { getViewerRuntimeContext } from "../viewerRuntime"
    const {
        store: viewerStore,
        search: searchStore,
        notes: notesStore,
    } = getViewerRuntimeContext()()
    const viewerUI = useViewerUI()
    import { useViewerUI } from "../state/viewerUI.svelte"
    import { viewport } from "$lib/shared/state/viewport.svelte"
    import {
        getViewerDocumentErrorDiagnostic,
        renderViewerPageLayers,
        type ViewerPagedDocument,
    } from "../viewerDocument"
    import Spinner from "$lib/shared/ui/Spinner.svelte"
    import * as m from "$lib/paraglide/messages"
    import { untrack } from "svelte"
    import { settingsStore } from "$lib/core/settings"
    import {
        getOffsetFromPoint,
        getTextNodeAndOffset,
        buildSpanRanges,
        findSpanByOffset,
        type SpanRange,
    } from "../stores/notesStore.svelte"
    import { browser } from "$app/environment"

    let isCompactPortrait = $derived(
        viewport.isCompact && viewport.innerWidth <= viewport.innerHeight,
    )

    let { pdf, pageNumber, scale, offsetY, width, height, registerSelectionPage } = $props<{
        pdf: ViewerPagedDocument
        pageNumber: number
        scale: number
        offsetY: number
        width: number
        height: number
        registerSelectionPage?: (
            pageNumber: number,
            container: HTMLElement,
            getSpanRanges: () => SpanRange[] | null,
        ) => () => void
    }>()

    let imageUrl = $state<string | null>(null)
    let isLoading = $state(false)
    let textLayerContainer = $state<HTMLElement | null>(null)
    let annotationLayerContainer = $state<HTMLDivElement | null>(null)

    const containerStyle = $derived(
        `width: ${width}px; height: ${height}px; --aspect-ratio: ${width} / ${height}; --display-scale: ${scale};`,
    )

    let bitmapPdf: ViewerPagedDocument | null = null
    let bitmapPage = -1

    $effect(() => {
        // Bitmap identity is intentionally limited to document, page, and render quality.
        // Display scale only changes containerStyle and never starts PDF.js work.
        const currentPdf = pdf
        const pageNo = pageNumber
        const quality = settingsStore.quality

        return untrack(() => {
            const identityChanged = bitmapPdf !== currentPdf || bitmapPage !== pageNo
            bitmapPdf = currentPdf
            bitmapPage = pageNo
            if (identityChanged) imageUrl = null

            const controller = new AbortController()

            const timeout = setTimeout(() => {
                isLoading = true
                currentPdf
                    .renderPage(pageNo, { quality, signal: controller.signal })
                    .then(({ url }: { url: string }) => {
                        if (controller.signal.aborted) return
                        imageUrl = url
                        isLoading = false
                    })
                    .catch((err: any) => {
                        if (controller.signal.aborted) return
                        if (!err.message?.startsWith("Rendering cancelled")) {
                            console.error(
                                `[ScrollPage] Failed to load page ${pageNo}`,
                                getViewerDocumentErrorDiagnostic(
                                    err,
                                    "Unable to render document page",
                                ),
                            )
                        }
                        isLoading = false
                    })
            }, 50)

            return () => {
                clearTimeout(timeout)
                controller.abort()
            }
        })
    })

    // Adapters may provide native layers; otherwise the generic text capability is used.

    $effect(() => {
        if (!textLayerContainer || !annotationLayerContainer || !pdf) return

        const targetPdf = pdf
        const pageNo = pageNumber
        const controller = new AbortController()
        const textContainer = textLayerContainer
        const annotationContainer = annotationLayerContainer

        const renderLayers = async () => {
            try {
                await renderViewerPageLayers(targetPdf, pageNo, {
                    textContainer,
                    annotationContainer,
                    signal: controller.signal,
                    onNavigate: (targetPage) =>
                        viewerStore.goToPage?.(targetPage, { isJump: true }),
                })
                if (controller.signal.aborted) return
                cachedSpanRanges = buildSpanRanges(textContainer)
                textLayerRenderCount += 1
            } catch (err) {
                if (controller.signal.aborted) return
                console.error(
                    `[ScrollPage] Failed to render layers for page ${pageNo}`,
                    getViewerDocumentErrorDiagnostic(err, "Unable to render document layers"),
                )
            }
        }

        const delayTimeout = setTimeout(() => {
            renderLayers()
        }, 250)

        return () => {
            clearTimeout(delayTimeout)
            controller.abort()
        }
    })

    let textLayerRenderCount = $state(0)
    let cachedSpanRanges: SpanRange[] | null = null

    $effect(() => {
        void textLayerRenderCount
        void searchStore.matches
        const pageNo = pageNumber

        untrack(() => {
            if (textLayerContainer && pdf) {
                highlightPage(pageNo, textLayerContainer)
            }
        })
        return () => {
            untrack(() => {
                searchStore.unregisterPageRanges(pageNo)
            })
        }
    })

    $effect(() => {
        void textLayerRenderCount
        void notesStore.notes
        const pageNo = pageNumber

        untrack(() => {
            if (textLayerContainer && pdf && cachedSpanRanges) {
                const pageNotes = notesStore.notes.filter((n) => n.pageNumber === pageNo)
                const noteRanges: { noteId: string; range: Range; color: string }[] = []

                if (pageNotes.length > 0) {
                    pageNotes.forEach((note) => {
                        const startEntry = findSpanByOffset(cachedSpanRanges!, note.start)
                        const endEntry = findSpanByOffset(cachedSpanRanges!, note.end)

                        if (startEntry && endEntry) {
                            try {
                                const range = new Range()
                                const startRes = getTextNodeAndOffset(
                                    startEntry.span,
                                    note.start - startEntry.start,
                                )
                                const endRes = getTextNodeAndOffset(
                                    endEntry.span,
                                    note.end - endEntry.start,
                                )
                                range.setStart(startRes.node, startRes.offset)
                                range.setEnd(endRes.node, endRes.offset)
                                noteRanges.push({
                                    noteId: note.id,
                                    range,
                                    color: note.color,
                                })

                                // Handle jumping/scrolling to note
                                if (
                                    notesStore.scrollingToNoteId === note.id &&
                                    textLayerContainer
                                ) {
                                    requestAnimationFrame(() => {
                                        range.startContainer.parentElement?.scrollIntoView({
                                            behavior: "smooth",
                                            block: "center",
                                        })
                                    })
                                    notesStore.scrollingToNoteId = null
                                }
                            } catch (e) {
                                console.error("[ScrollPage] Failed to create note range:", e)
                            }
                        }
                    })
                }

                notesStore.registerPageRanges(pageNo, noteRanges)
            }
        })
        return () => {
            untrack(() => {
                notesStore.unregisterPageRanges(pageNo)
            })
        }
    })

    // Register this virtual page with CanvasPane's single document-level selection listener.
    $effect(() => {
        if (!browser || !textLayerContainer || !registerSelectionPage) return
        return registerSelectionPage(pageNumber, textLayerContainer, () => cachedSpanRanges)
    })

    // Highlight click listener
    $effect(() => {
        if (!browser || !pdf || !textLayerContainer) return
        const containerEl = textLayerContainer

        const handleTextLayerClick = (e: MouseEvent) => {
            const spans = cachedSpanRanges
            if (!spans || !containerEl) return
            const target = e.target as HTMLElement
            if (!containerEl.contains(target)) return

            const clickOffset = getOffsetFromPoint(e, containerEl, spans)
            if (clickOffset !== null) {
                const currentBook = viewerStore.getCurrentBook()
                if (!currentBook) return

                const clickedNote = notesStore.notes.find(
                    (n) =>
                        n.bookId === currentBook.id &&
                        n.pageNumber === pageNumber &&
                        clickOffset >= n.start &&
                        clickOffset <= n.end,
                )
                if (clickedNote) {
                    notesStore.activePopup = {
                        note: clickedNote,
                        x: e.clientX,
                        y: e.clientY,
                    }
                    notesStore.activeSelection = null
                    e.stopPropagation()
                    e.preventDefault()
                }
            }
        }

        containerEl.addEventListener("click", handleTextLayerClick)

        return () => {
            containerEl.removeEventListener("click", handleTextLayerClick)
        }
    })

    function highlightPage(pageNo: number, textContainer: HTMLElement) {
        const matches = searchStore.matches.filter((m) => m.pageNumber === pageNo)
        const ranges: Range[] = []

        if (matches.length > 0 && cachedSpanRanges) {
            matches.forEach((match) => {
                const startEntry = findSpanByOffset(cachedSpanRanges!, match.start)
                const endEntry = findSpanByOffset(cachedSpanRanges!, match.end)

                if (startEntry && endEntry) {
                    try {
                        const range = new Range()
                        range.setStart(startEntry.textNode, match.start - startEntry.start)
                        range.setEnd(endEntry.textNode, match.end - endEntry.start)
                        ranges.push(range)
                    } catch (e) {
                        console.error("[ScrollPage] Failed to create highlight range:", e)
                        ranges.push(null as any) // Keep index aligned
                    }
                }
            })
        }

        searchStore.registerPageRanges(pageNo, ranges)
    }
</script>

<div
    class="scroll-page"
    style="top: {offsetY}px;"
    data-page={pageNumber}
    class:mobile-full-width={isCompactPortrait}
>
    <div class="page-container" style={containerStyle}>
        {#if !viewport.isCompact}
            <div class="scroll-page-badge" class:hidden-toolbars={!viewerUI.isToolbarsVisible}>
                {m.page()}
                {pageNumber}
            </div>
        {/if}
        {#if imageUrl}
            <div class="pdf-image-wrapper" style={containerStyle}>
                <img
                    src={imageUrl}
                    alt={m.page_render_alt({ page: pageNumber })}
                    class="pdf-image"
                />
                <div bind:this={textLayerContainer} class="textLayer" data-page={pageNumber}></div>
                <div bind:this={annotationLayerContainer} class="annotationLayer"></div>
            </div>
        {:else}
            <div class="placeholder" style={containerStyle}>
                <div class="loader-overlay">
                    <Spinner variant="dots" size="sm" label="" />
                </div>
            </div>
        {/if}
    </div>
</div>

<style>
    .scroll-page {
        position: absolute;
        left: 0;
        right: 0;
        display: flex;
        justify-content: safe center;
        align-items: flex-start;
        padding: 40px;
        box-sizing: border-box;
    }

    .page-container {
        position: relative;
    }

    .pdf-image-wrapper {
        border: var(--border-elevated) solid var(--border-color);
        box-shadow: var(--shadow-elevated);
        display: inline-flex;
        position: relative;
    }

    .pdf-image {
        display: block;
        width: 100%;
        height: 100%;
    }

    :global(html.dark) .pdf-image {
        filter: invert(1) hue-rotate(180deg);
    }

    .placeholder {
        border: var(--border-elevated) solid var(--border-color);
        box-shadow: var(--shadow-elevated);
        background: var(--canvas-bg-color);
        display: flex;
        align-items: center;
        justify-content: center;
        position: relative;
    }

    .loader-overlay {
        position: absolute;
        inset: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        background: rgba(0, 0, 0, 0.05);
    }

    @media (--desktop) {
        .scroll-page {
            padding: 8px 0px;
        }

        .pdf-image-wrapper,
        .placeholder {
            border-width: 1px;
        }
    }

    .scroll-page.mobile-full-width {
        padding: 0;
    }

    .scroll-page.mobile-full-width .pdf-image-wrapper,
    .scroll-page.mobile-full-width .placeholder {
        border-width: 0;
        border-bottom: 2px solid var(--border-color) !important;
        box-shadow: none;
    }

    .scroll-page-badge {
        position: absolute;
        top: -12px;
        left: -12px;
        background: var(--surface-color);
        color: var(--faded-text-color);
        border: 1px solid var(--color-rule);
        border-radius: var(--radius-sm);
        padding: 4px 10px;
        font-size: var(--font-size-xs);
        font-weight: 500;
        z-index: var(--z-10);
        pointer-events: none;
        transition:
            opacity 0.2s ease,
            transform 0.2s ease;
    }

    .scroll-page-badge.hidden-toolbars {
        opacity: 0;
        transform: translateY(-8px);
    }
</style>
