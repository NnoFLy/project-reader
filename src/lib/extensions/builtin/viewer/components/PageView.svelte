<script lang="ts">
    import type { ViewerPagedDocument } from "../viewerDocument"
    import { getViewerDocumentErrorDiagnostic, renderViewerPageLayers } from "../viewerDocument"
    import { settingsStore } from "$lib/core/settings"
    import { viewerStore } from "../stores/viewerStore.svelte"
    import { searchStore } from "../stores/searchStore.svelte"
    import {
        notesStore,
        getGlobalOffset,
        getOffsetFromPoint,
        getTextNodeAndOffset,
        buildSpanRanges,
        findSpanByOffset,
        type SpanRange,
    } from "../stores/notesStore.svelte"
    import { browser } from "$app/environment"
    import { untrack, onMount } from "svelte"
    import * as m from "$lib/paraglide/messages"

    let {
        pdf,
        pageNumber,
        image,
        width,
        height,
        scale,
        renderLayers = true,
        class: className = "",
    } = $props<{
        pdf: ViewerPagedDocument | null
        pageNumber: number
        image: string | null
        width: number
        height: number
        scale: number
        renderLayers?: boolean
        class?: string
    }>()

    let textLayerEl = $state<HTMLElement | null>(null)
    let annotationLayerEl = $state<HTMLDivElement | null>(null)
    let renderCount = $state(0)
    let cachedSpanRanges = $state<SpanRange[] | null>(null)
    let controller: AbortController | null = null

    async function renderPageLayers(
        targetPdf: ViewerPagedDocument,
        pageNo: number,
        textContainer: HTMLElement,
        annotationContainer: HTMLDivElement | null,
        signal?: AbortSignal,
    ) {
        try {
            await renderViewerPageLayers(targetPdf, pageNo, {
                textContainer,
                annotationContainer,
                signal,
                onNavigate: () => undefined,
            })
            if (signal?.aborted) return
            cachedSpanRanges = buildSpanRanges(textContainer)
            renderCount += 1
        } catch (err) {
            if (signal?.aborted) return
            console.error(
                `[PageView] Failed to render page layers for page ${pageNo}`,
                getViewerDocumentErrorDiagnostic(err, "Unable to render document layers"),
            )
        }
    }

    $effect(() => {
        if (!renderLayers || !pdf || !textLayerEl || !annotationLayerEl) return

        const targetPdf = pdf
        const pageNo = pageNumber
        const textContainer = textLayerEl
        const annotationContainer = annotationLayerEl

        controller?.abort()
        const newController = new AbortController()
        controller = newController

        const delayTimeout = setTimeout(() => {
            renderPageLayers(
                targetPdf,
                pageNo,
                textContainer,
                annotationContainer,
                newController.signal,
            )
        }, 150)

        return () => {
            clearTimeout(delayTimeout)
            newController.abort()
        }
    })

    // Search Highlights
    $effect(() => {
        if (!renderLayers) return
        const _count = renderCount
        const _matches = searchStore.matches

        untrack(() => {
            if (textLayerEl && pdf) {
                const matches = searchStore.matches.filter((m) => m.pageNumber === pageNumber)
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
                                ranges.push(null as any)
                            }
                        }
                    })
                }
                searchStore.registerPageRanges(pageNumber, ranges)
            }
        })
        return () => {
            untrack(() => {
                searchStore.unregisterPageRanges(pageNumber)
            })
        }
    })

    // Notes Highlights
    $effect(() => {
        if (!renderLayers) return
        const _count = renderCount
        const _notes = notesStore.notes

        untrack(() => {
            if (textLayerEl && pdf) {
                const pageNotes = notesStore.notes.filter((n) => n.pageNumber === pageNumber)
                const noteRanges: { noteId: string; range: Range; color: string }[] = []

                if (pageNotes.length > 0 && cachedSpanRanges) {
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
                                noteRanges.push({ noteId: note.id, range, color: note.color })
                            } catch (e) {}
                        }
                    })
                }
                notesStore.registerPageRanges(pageNumber, noteRanges)
            }
        })
        return () => {
            untrack(() => {
                notesStore.unregisterPageRanges(pageNumber)
            })
        }
    })

    function handleSelectionChange() {
        if (!browser || !pdf || !textLayerEl || !cachedSpanRanges) return
        const selection = document.getSelection()
        if (!selection || selection.isCollapsed) return

        const range = selection.getRangeAt(0)
        if (
            !textLayerEl.contains(range.startContainer) ||
            !textLayerEl.contains(range.endContainer)
        )
            return

        const currentBook = viewerStore.getCurrentBook()
        if (!currentBook) return

        const startOffset = getGlobalOffset(
            range.startContainer,
            range.startOffset,
            cachedSpanRanges,
        )
        const endOffset = getGlobalOffset(range.endContainer, range.endOffset, cachedSpanRanges)

        if (startOffset !== null && endOffset !== null) {
            const start = Math.min(startOffset, endOffset)
            const end = Math.max(startOffset, endOffset)
            const text = selection.toString()
            const rect = range.getBoundingClientRect()
            notesStore.activeSelection = {
                bookId: currentBook.id,
                pageNumber,
                start,
                end,
                text,
                x: rect.left + rect.width / 2,
                y: rect.top,
                bottomY: rect.bottom,
            }
        }
    }

    function handleTextLayerClick(e: MouseEvent) {
        if (!pdf || !textLayerEl || !cachedSpanRanges) return
        const clickOffset = getOffsetFromPoint(e, textLayerEl, cachedSpanRanges)
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

    onMount(() => {
        document.addEventListener("selectionchange", handleSelectionChange)
        return () => {
            document.removeEventListener("selectionchange", handleSelectionChange)
        }
    })
</script>

<!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events (PDF text-layer hit testing is an optional pointer shortcut; notes remain available as semantic sidebar buttons) -->
<div
    class="pdf-image-wrapper {className}"
    style="width: {width}px; height: {height}px; --aspect-ratio: {width} / {height}; --display-scale: {scale};"
    onclick={handleTextLayerClick}
>
    {#if image}
        <img src={image} alt={m.page_render_alt({ page: pageNumber })} class="pdf-image" />
        {#if renderLayers}
            <div bind:this={textLayerEl} class="textLayer" data-page={pageNumber}></div>
            <div bind:this={annotationLayerEl} class="annotationLayer"></div>
        {/if}
    {/if}
</div>

<style>
    .pdf-image-wrapper {
        border: 3px solid var(--border-color);
        box-shadow: 12px 12px 0 var(--shadow-color);
        display: inline-flex;
        position: relative;
        transition:
            width 0.2s cubic-bezier(0.4, 0, 0.2, 1),
            height 0.2s cubic-bezier(0.4, 0, 0.2, 1),
            transform 0.2s cubic-bezier(0.4, 0, 0.2, 1);
        transform-origin: top center;
    }

    .pdf-image {
        display: block;
        width: 100%;
        height: 100%;
    }

    :global(html.dark) .pdf-image {
        filter: invert(1) hue-rotate(180deg);
    }
</style>
