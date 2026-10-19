<script lang="ts">
    import { viewport } from "$lib/shared/state/viewport.svelte"
    import * as m from "$lib/paraglide/messages"
    import Spinner from "$lib/shared/ui/Spinner.svelte"
    import {
        getViewerDocumentErrorDiagnostic,
        getViewerPageDimensions,
        renderViewerPageLayers,
        type ViewerPagedDocument,
    } from "../viewerDocument"
    import { CONSTANTS, DEFAULT_SETTINGS, settingsStore } from "../viewerHost"
    import { viewerStore } from "../stores/viewerStore.svelte"
    import { safeStorageGet } from "$lib/shared/state/safeStorage"
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
    import ScrollPage from "./ScrollPage.svelte"
    import { onDestroy, untrack } from "svelte"
    import { MediaQuery, SvelteMap } from "svelte/reactivity"
    import { MEDIA_QUERIES } from "$lib/shared/state/breakpoints"
    import { commandsStore, useCommands } from "$lib/core/commands"
    import { createViewerFitWidthCommand } from "../commands/viewerFitWidthCommand"
    import { ViewerLinkService } from "./ViewerLinkService"
    import { promptStore } from "../viewerHost"
    import {
        captureScrollAnchor,
        restoreScrollAnchor,
        type ScrollAnchor,
    } from "../utils/scrollAnchor"
    import { getBitmapPageScale, getBitmapWrapperStyle } from "./pageBitmapGeometry"

    const AUTO_SCROLL_TIMEOUT_MS = 800

    let {
        isPageLoading = false,
        currentPageImage = null,
        currentPageImage2 = null,
        currentPage = $bindable(),
        scrollPosition = $bindable(),
        container = $bindable(null),
        layoutMode = "single",
        scale = settingsStore.scale,
        pdf,
        currentPageDim1: propPageDim1 = null,
        currentPageDim2: propPageDim2 = null,
        renderLayers = true,
    } = $props<{
        isPageLoading?: boolean
        currentPageImage?: string | null
        currentPageImage2?: string | null
        currentPage: number
        scrollPosition: number
        container?: HTMLElement | null
        layoutMode?: "single" | "split" | "scroll"
        scale?: number
        pdf: ViewerPagedDocument | null
        currentPageDim1?: { width: number; height: number } | null
        currentPageDim2?: { width: number; height: number } | null
        renderLayers?: boolean
    }>()

    let containerWidth = $state(0)
    let isShortHeight = $derived(viewport.isShortHeight)
    let isCompactPortrait = $derived(
        viewport.isCompact && viewport.innerWidth <= viewport.innerHeight,
    )
    let effectiveScale = $derived(isCompactPortrait ? DEFAULT_SETTINGS.scale : scale)
    let hasInitiallyFit = false
    let hasRestoredScroll = false

    function fitToWidth() {
        if (!pdf || containerWidth <= 0) return
        if (viewport.isCompact) {
            if (!isCompactPortrait) settingsStore.scale = DEFAULT_SETTINGS.scale
            return
        }

        const pageDimension = currentPageDim1 || fallbackPageDim1
        if (!pageDimension) return
        const horizontalPadding = containerWidth < 900 ? 32 : 80

        let targetScale: number
        const isSplitSideBySide = layoutMode === "split"
        if (isSplitSideBySide) {
            const gap = 32
            const borderShadowAllowance = 24
            const availableWidth = Math.max(
                containerWidth - horizontalPadding - borderShadowAllowance - gap,
                100,
            )
            const cappedAvailableWidth = Math.min(availableWidth, 3400)
            targetScale = cappedAvailableWidth / (pageDimension.width * 2)
        } else {
            const availableWidth = Math.max(containerWidth - horizontalPadding - 12, 100)
            const cappedAvailableWidth = Math.min(availableWidth, 1700)
            targetScale = cappedAvailableWidth / pageDimension.width
        }

        settingsStore.scale = Math.max(
            CONSTANTS.minScale,
            Math.min(CONSTANTS.maxScale, targetScale),
        )
    }

    $effect(() => {
        if (pdf && containerWidth > 0 && !hasInitiallyFit) {
            hasInitiallyFit = true
            if (!viewport.isCompact) {
                const hasSavedScale = (() => {
                    try {
                        const saved = safeStorageGet("settings")
                        if (saved) {
                            const parsed = JSON.parse(saved)
                            return typeof parsed.scale === "number"
                        }
                    } catch {}
                    return false
                })()

                if (!hasSavedScale) {
                    fitToWidth()
                }
            }
        }
    })

    useCommands([createViewerFitWidthCommand(fitToWidth)])

    function compactZoomMultiplier(targetScale = effectiveScale) {
        return targetScale / DEFAULT_SETTINGS.scale
    }

    function getScrollPageScale(
        dim: { width: number; height: number },
        targetScale = effectiveScale,
    ) {
        if (viewport.isCompact && containerWidth > 0) {
            return (containerWidth / dim.width) * compactZoomMultiplier(targetScale)
        }
        return targetScale
    }

    const pageScale1 = $derived.by(() => {
        const dimension = currentPageDim1 || fallbackPageDim1
        if (!dimension) return effectiveScale
        const otherDimension = currentPageDim2 || (layoutMode === "split" ? dimension : null)
        return getBitmapPageScale({
            containerWidth,
            dimension,
            otherDimension,
            layout: layoutMode === "split" ? "split" : "single",
            effectiveScale,
            defaultScale: DEFAULT_SETTINGS.scale,
            compact: viewport.isCompact && !!pdf,
        })
    })

    const pageScale2 = $derived.by(() => {
        const dimension = currentPageDim2 || fallbackPageDim2 || currentPageDim1 || fallbackPageDim1
        if (!dimension) return effectiveScale
        const otherDimension = currentPageDim1 || fallbackPageDim1 || dimension
        return getBitmapPageScale({
            containerWidth,
            dimension,
            otherDimension,
            layout: layoutMode === "split" ? "split" : "single",
            effectiveScale,
            defaultScale: DEFAULT_SETTINGS.scale,
            compact: viewport.isCompact && !!pdf,
        })
    })

    function getPageHeight(dim: { width: number; height: number }, targetScale = effectiveScale) {
        return dim.height * getScrollPageScale(dim, targetScale)
    }

    const wrapperStyle1 = $derived.by(() => {
        const dim = currentPageDim1 || fallbackPageDim1
        return dim ? getBitmapWrapperStyle(dim, pageScale1) : ""
    })

    const wrapperStyle2 = $derived.by(() => {
        const dim = currentPageDim2 || fallbackPageDim2 || currentPageDim1 || fallbackPageDim1
        return dim ? getBitmapWrapperStyle(dim, pageScale2) : ""
    })

    let isAutoScrolling = false
    let lastObservedPage = $state(-1)
    let autoScrollTimeout: ReturnType<typeof setTimeout> | undefined

    let pageDimensions = $state.raw<{ width: number; height: number }[]>([])
    let scrollTop = $state(0)
    let containerHeight = $state(0)
    const mobileQuery = new MediaQuery(MEDIA_QUERIES.DESKTOP)
    let isMobile = $derived(mobileQuery.current)

    let fallbackPageDim1 = $state<{ width: number; height: number } | null>(null)
    let fallbackPageDim2 = $state<{ width: number; height: number } | null>(null)

    let currentPageDim1 = $derived(propPageDim1 || fallbackPageDim1)
    let currentPageDim2 = $derived(propPageDim2 || fallbackPageDim2)

    let textLayer1 = $state<HTMLElement | null>(null)
    let textLayer2 = $state<HTMLElement | null>(null)
    let annotationLayer1 = $state<HTMLDivElement | null>(null)
    let annotationLayer2 = $state<HTMLDivElement | null>(null)
    let textLayer1RenderCount = $state(0)
    let textLayer2RenderCount = $state(0)
    let cachedSpanRanges1: SpanRange[] | null = null
    let cachedSpanRanges2: SpanRange[] | null = null

    type SelectionPage = {
        container: HTMLElement
        getSpanRanges: () => SpanRange[] | null
    }
    const scrollSelectionPages = new SvelteMap<number, SelectionPage>()

    function registerSelectionPage(
        pageNumber: number,
        selectionContainer: HTMLElement,
        getSpanRanges: () => SpanRange[] | null,
    ) {
        const page = { container: selectionContainer, getSpanRanges }
        scrollSelectionPages.set(pageNumber, page)
        return () => {
            if (scrollSelectionPages.get(pageNumber) === page) {
                scrollSelectionPages.delete(pageNumber)
            }
        }
    }

    $effect(() => {
        if (!pdf || layoutMode === "scroll") return

        const p1 = currentPage
        const p2 = layoutMode === "split" ? currentPage + 1 : null

        untrack(() => {
            pdf!
                .getPage(p1)
                .then(({ width, height }: { width: number; height: number }) => {
                    fallbackPageDim1 = { width, height }
                })
                .catch((err: unknown) => {
                    console.warn(
                        "[CanvasPane] Failed to get page dimension for page 1:",
                        getViewerDocumentErrorDiagnostic(err, "Unable to read document page"),
                    )
                })
            if (p2 && p2 <= pdf!.pageCount) {
                pdf!
                    .getPage(p2)
                    .then(({ width, height }: { width: number; height: number }) => {
                        fallbackPageDim2 = { width, height }
                    })
                    .catch((err: unknown) => {
                        console.warn(
                            "[CanvasPane] Failed to get page dimension for page 2:",
                            getViewerDocumentErrorDiagnostic(err, "Unable to read document page"),
                        )
                    })
            } else {
                fallbackPageDim2 = null
            }
        })
    })

    const PAGE_GAP = $derived.by(() => {
        if (viewport.isCompact && !isShortHeight) return 2
        if (isMobile) return 16
        return 80
    })

    $effect(() => {
        if (pdf && layoutMode === "scroll") {
            const controller = new AbortController()
            const loadDimensions = async () => {
                try {
                    const dims = await getViewerPageDimensions(pdf, controller.signal)
                    if (!controller.signal.aborted) pageDimensions = [...dims]
                } catch (err) {
                    if (!controller.signal.aborted) {
                        console.warn(
                            "[CanvasPane] Failed to load all page dimensions:",
                            getViewerDocumentErrorDiagnostic(
                                err,
                                "Unable to read document dimensions",
                            ),
                        )
                    }
                }
            }
            void loadDimensions()
            return () => {
                controller.abort()
                pageDimensions = []
                lastObservedPage = -1
            }
        } else {
            pageDimensions = []
            lastObservedPage = -1
        }
    })

    const pageOffsets = $derived.by(() => {
        if (pageDimensions.length === 0) return []
        const offsets: number[] = []
        let currentOffset = 0
        for (const dim of pageDimensions) {
            offsets.push(currentOffset)
            currentOffset += getPageHeight(dim) + PAGE_GAP
        }
        return offsets
    })

    const totalHeight = $derived(
        pageOffsets.length > 0
            ? pageOffsets[pageOffsets.length - 1] +
                  getPageHeight(pageDimensions[pageDimensions.length - 1]) +
                  PAGE_GAP
            : 0,
    )

    let lastUpdatedScrollTop = 0
    let scrollEndTimeout: ReturnType<typeof setTimeout> | undefined
    let rafId: number | null = null
    let pendingResizeAnchor: ScrollAnchor | null = null
    let resizeRestoreRaf: number | null = null
    let isResizeRestoring = false

    function updateContainerWidth(nextWidth: number) {
        if (nextWidth === containerWidth) return
        if (
            viewport.isCompact &&
            layoutMode === "scroll" &&
            container &&
            hasRestoredScroll &&
            pageOffsets.length > 0
        ) {
            pendingResizeAnchor ??= captureScrollAnchor(
                currentPage,
                container.scrollTop,
                container.clientHeight,
                pageOffsets,
                pageDimensions.map((dimension) => getPageHeight(dimension)),
            )
            isResizeRestoring = pendingResizeAnchor !== null
            if (scrollEndTimeout) clearTimeout(scrollEndTimeout)
        }

        containerWidth = nextWidth
        if (!pendingResizeAnchor) return
        if (resizeRestoreRaf !== null) cancelAnimationFrame(resizeRestoreRaf)
        resizeRestoreRaf = requestAnimationFrame(() => {
            if (!container || !pendingResizeAnchor) return
            const heights = pageDimensions.map((dimension) => getPageHeight(dimension))
            const targetTop = restoreScrollAnchor(
                pendingResizeAnchor,
                container.clientHeight,
                pageOffsets,
                heights,
                container.scrollHeight - container.clientHeight,
            )
            container.scrollTo({ top: targetTop, behavior: "auto" })
            scrollTop = targetTop
            lastUpdatedScrollTop = targetTop
            lastObservedPage = pendingResizeAnchor.page
            resizeRestoreRaf = requestAnimationFrame(() => {
                pendingResizeAnchor = null
                isResizeRestoring = false
                resizeRestoreRaf = null
            })
        })
    }

    onDestroy(() => {
        if (scrollEndTimeout) clearTimeout(scrollEndTimeout)
        if (rafId !== null) cancelAnimationFrame(rafId)
        if (zoomRestoreRaf !== null) cancelAnimationFrame(zoomRestoreRaf)
        if (resizeRestoreRaf !== null) cancelAnimationFrame(resizeRestoreRaf)
    })

    function findPageAtOffset(offset: number): number {
        if (pageOffsets.length === 0) return 1
        let low = 0
        let high = pageOffsets.length - 1
        while (low <= high) {
            const mid = (low + high) >> 1
            const top = pageOffsets[mid]
            const height = getPageHeight(pageDimensions[mid]) + PAGE_GAP
            if (offset >= top && offset < top + height) {
                return mid + 1
            } else if (offset < top) {
                high = mid - 1
            } else {
                low = mid + 1
            }
        }
        if (offset < pageOffsets[0]) return 1
        return pageOffsets.length
    }

    function syncScrollState(
        currentScrollTop: number,
        currentContainerHeight: number,
        scrollHeight: number,
    ) {
        void scrollHeight
        scrollTop = currentScrollTop
        containerHeight = currentContainerHeight
        lastUpdatedScrollTop = currentScrollTop

        if (layoutMode === "scroll") {
            if (pageOffsets.length === 0) return
            const viewportMiddle = currentScrollTop + currentContainerHeight / 2

            const foundPage = findPageAtOffset(viewportMiddle)

            if (foundPage !== currentPage) {
                lastObservedPage = foundPage
                currentPage = foundPage
            }
            const pageTop = pageOffsets[foundPage - 1]
            const pageHeight = getPageHeight(pageDimensions[foundPage - 1])
            scrollPosition = (currentScrollTop - pageTop) / pageHeight
        } else {
            const pageEl = container?.querySelector(
                ".pdf-image-wrapper, .book-spread",
            ) as HTMLElement | null
            if (pageEl) {
                const pageHeight = pageEl.offsetHeight
                const pageTop = pageEl.offsetTop
                scrollPosition =
                    pageHeight > 0 ? Math.max(0, (currentScrollTop - pageTop) / pageHeight) : 0
            } else {
                scrollPosition = 0
            }
        }
    }

    function syncScrollStateFallback() {
        if (typeof window !== "undefined" && !("onscrollend" in window)) {
            if (container && hasRestoredScroll && !isResizeRestoring) {
                syncScrollState(container.scrollTop, container.clientHeight, container.scrollHeight)
            }
        }
    }

    function handleScroll(e: Event) {
        if (!hasRestoredScroll || isResizeRestoring) return

        const target = e.target as HTMLElement

        if (isAutoScrolling) return

        // Throttle updates using requestAnimationFrame for smoother performance
        if (rafId === null) {
            rafId = requestAnimationFrame(() => {
                rafId = null

                let shouldUpdate = false
                const currentScrollTop = target.scrollTop
                const currentContainerHeight = target.clientHeight

                if (layoutMode === "scroll") {
                    if (pageOffsets.length === 0) return
                    if (lastObservedPage === -1) return

                    const viewportMiddle = currentScrollTop + currentContainerHeight / 2
                    const foundPage = findPageAtOffset(viewportMiddle)

                    if (
                        foundPage !== currentPage ||
                        Math.abs(currentScrollTop - lastUpdatedScrollTop) > 150
                    ) {
                        shouldUpdate = true
                    }
                } else {
                    if (Math.abs(currentScrollTop - lastUpdatedScrollTop) > 150) {
                        shouldUpdate = true
                    }
                }

                if (shouldUpdate) {
                    syncScrollState(currentScrollTop, currentContainerHeight, target.scrollHeight)
                }
            })
        }

        if (typeof window !== "undefined" && !("onscrollend" in window)) {
            if (scrollEndTimeout) clearTimeout(scrollEndTimeout)
            scrollEndTimeout = setTimeout(() => {
                if (container && hasRestoredScroll && !isResizeRestoring) {
                    syncScrollState(
                        container.scrollTop,
                        container.clientHeight,
                        container.scrollHeight,
                    )
                }
            }, 150)
        }
    }

    const visibleRange = $derived.by(() => {
        if (pageOffsets.length === 0 || containerHeight === 0) return []

        const viewportTop = scrollTop
        const viewportBottom = scrollTop + containerHeight

        const buffer = containerHeight
        const renderTop = viewportTop - buffer
        const renderBottom = viewportBottom + buffer

        let startIdx = 0
        let endIdx = pageDimensions.length - 1

        // Use binary search to find startIdx
        let low = 0
        let high = pageOffsets.length - 1
        while (low <= high) {
            const mid = (low + high) >> 1
            const top = pageOffsets[mid]
            const height = getPageHeight(pageDimensions[mid])
            if (top + height + PAGE_GAP > renderTop) {
                startIdx = mid
                high = mid - 1
            } else {
                low = mid + 1
            }
        }

        // Use binary search to find endIdx
        low = startIdx
        high = pageOffsets.length - 1
        while (low <= high) {
            const mid = (low + high) >> 1
            if (pageOffsets[mid] < renderBottom) {
                endIdx = mid
                low = mid + 1
            } else {
                high = mid - 1
            }
        }

        const range: number[] = []
        for (let i = Math.max(0, startIdx); i <= Math.min(pageDimensions.length - 1, endIdx); i++) {
            range.push(i)
        }
        return range
    })

    type ZoomAnchor = {
        page: number
        vertical: number
        horizontal: number
    }

    let lastScale = $state(-1)
    let zoomRestoreRaf: number | null = null
    let pendingZoomAnchor: ZoomAnchor | null = null

    function getOffsetsAtScale(targetScale: number) {
        const offsets: number[] = []
        let currentOffset = 0
        for (const dim of pageDimensions) {
            offsets.push(currentOffset)
            currentOffset += getPageHeight(dim, targetScale) + PAGE_GAP
        }
        return offsets
    }

    function findPageAtScaledOffset(offset: number, offsets: number[], targetScale: number) {
        for (let index = 0; index < offsets.length; index += 1) {
            if (
                offset <
                offsets[index] + getPageHeight(pageDimensions[index], targetScale) + PAGE_GAP
            ) {
                return index + 1
            }
        }
        return Math.max(1, offsets.length)
    }

    $effect(() => {
        const currentScale = effectiveScale
        const offsets = pageOffsets
        const targetPage = currentPage

        untrack(() => {
            if (lastScale === -1) {
                lastScale = currentScale
                return
            }
            if (!container || !hasRestoredScroll || currentScale === lastScale) return

            const oldScale = lastScale
            let anchor = pendingZoomAnchor
            if (!anchor) {
                if (layoutMode === "scroll" && pageDimensions.length > 0) {
                    const oldOffsets = getOffsetsAtScale(oldScale)
                    const viewportCenter = scrollTop + container.clientHeight / 2
                    const page = findPageAtScaledOffset(viewportCenter, oldOffsets, oldScale)
                    const pageHeight = getPageHeight(pageDimensions[page - 1], oldScale)
                    const oldContentWidth = Math.max(
                        container.clientWidth,
                        ...pageDimensions.map(
                            (dim) => dim.width * getScrollPageScale(dim, oldScale),
                        ),
                    )
                    anchor = {
                        page,
                        vertical: (viewportCenter - oldOffsets[page - 1]) / pageHeight,
                        horizontal:
                            oldContentWidth > container.clientWidth
                                ? container.scrollLeft / (oldContentWidth - container.clientWidth)
                                : 0.5,
                    }
                } else {
                    const scaleRatio = currentScale / oldScale
                    const oldWidth = Math.max(
                        container.clientWidth,
                        container.scrollWidth / scaleRatio,
                    )
                    const oldHeight = Math.max(
                        container.clientHeight,
                        container.scrollHeight / scaleRatio,
                    )
                    anchor = {
                        page: targetPage,
                        vertical:
                            oldHeight > container.clientHeight
                                ? (container.scrollTop + container.clientHeight / 2) / oldHeight
                                : 0.5,
                        horizontal:
                            oldWidth > container.clientWidth
                                ? container.scrollLeft / (oldWidth - container.clientWidth)
                                : 0.5,
                    }
                }
            }

            pendingZoomAnchor = anchor
            lastScale = currentScale
            isAutoScrolling = true
            if (zoomRestoreRaf !== null) cancelAnimationFrame(zoomRestoreRaf)

            if (layoutMode === "scroll" && offsets.length > 0 && pageDimensions[anchor.page - 1]) {
                const pageTop = offsets[anchor.page - 1]
                const pageHeight = getPageHeight(pageDimensions[anchor.page - 1])
                const targetTop = Math.max(
                    0,
                    pageTop + anchor.vertical * pageHeight - container.clientHeight / 2,
                )
                scrollTop = targetTop
                lastUpdatedScrollTop = targetTop
                currentPage = anchor.page
                lastObservedPage = anchor.page
                scrollPosition = (targetTop - pageTop) / pageHeight
            }

            zoomRestoreRaf = requestAnimationFrame(() => {
                if (!container || !pendingZoomAnchor) return
                const latestAnchor = pendingZoomAnchor
                let targetTop: number
                if (
                    layoutMode === "scroll" &&
                    pageOffsets.length > 0 &&
                    pageDimensions[latestAnchor.page - 1]
                ) {
                    const pageTop = pageOffsets[latestAnchor.page - 1]
                    const pageHeight = getPageHeight(pageDimensions[latestAnchor.page - 1])
                    targetTop =
                        pageTop + latestAnchor.vertical * pageHeight - container.clientHeight / 2
                } else {
                    targetTop =
                        latestAnchor.vertical * container.scrollHeight - container.clientHeight / 2
                }
                const maxLeft = Math.max(0, container.scrollWidth - container.clientWidth)
                container.scrollTo({
                    top: Math.max(0, targetTop),
                    left: latestAnchor.horizontal * maxLeft,
                    behavior: "auto",
                })
                syncScrollState(container.scrollTop, container.clientHeight, container.scrollHeight)
                pendingZoomAnchor = null
                zoomRestoreRaf = null
                isAutoScrolling = false
            })
        })
    })

    $effect(() => {
        if (layoutMode !== "scroll") return
        const targetPage = currentPage
        const offsets = pageOffsets

        untrack(() => {
            if (!hasRestoredScroll || !container || offsets.length === 0) return
            if (pendingZoomAnchor || targetPage === lastObservedPage) return

            const targetOffset = offsets[targetPage - 1]
            const behavior = settingsStore.animations && lastObservedPage !== -1 ? "smooth" : "auto"

            isAutoScrolling = true
            container.scrollTo({ top: targetOffset, behavior })
            scrollTop = targetOffset
            lastObservedPage = targetPage

            if (autoScrollTimeout) clearTimeout(autoScrollTimeout)
            if (behavior === "smooth") {
                autoScrollTimeout = setTimeout(() => {
                    isAutoScrolling = false
                    syncScrollStateFallback()
                }, AUTO_SCROLL_TIMEOUT_MS)
            } else {
                requestAnimationFrame(() => {
                    isAutoScrolling = false
                    syncScrollStateFallback()
                })
            }
        })
    })

    $effect(() => {
        void pdf
        void layoutMode
        // Track currentPage only for single/split layouts.
        // In scroll layout, the user scrolling changes currentPage, so resetting here would hijack the scroll.
        if (layoutMode !== "scroll") void currentPage
        untrack(() => {
            hasRestoredScroll = false
        })
    })

    $effect(() => {
        if (!container || !pdf || isPageLoading) return
        if (layoutMode === "scroll" && pageOffsets.length === 0) return

        // Register currentPage as a dependency ONLY when NOT in scroll layout
        if (layoutMode !== "scroll") void currentPage

        untrack(() => {
            if (hasRestoredScroll) return

            const targetScrollPosition = scrollPosition
            if (targetScrollPosition === 0 && layoutMode !== "scroll") {
                lastObservedPage = currentPage
                container!.scrollTo({ top: 0, left: 0, behavior: "auto" })
                lastUpdatedScrollTop = 0
                hasRestoredScroll = true
                return
            }

            if (layoutMode === "scroll") {
                const pageIndex = Math.min(currentPage - 1, pageDimensions.length - 1)
                if (pageIndex >= 0 && pageDimensions[pageIndex]) {
                    const pageTop = pageOffsets[pageIndex]
                    const pageHeight = getPageHeight(pageDimensions[pageIndex])
                    const targetScrollTop = pageTop + targetScrollPosition * pageHeight
                    container!.scrollTo({
                        top: targetScrollTop,
                        left: 0,
                        behavior: "auto",
                    })
                    scrollTop = targetScrollTop
                    lastUpdatedScrollTop = targetScrollTop
                }
            } else {
                const pageEl = container!.querySelector(
                    ".pdf-image-wrapper, .book-spread",
                ) as HTMLElement | null
                if (pageEl) {
                    const pageHeight = pageEl.offsetHeight
                    const pageTop = pageEl.offsetTop
                    const targetScrollTop = pageTop + targetScrollPosition * pageHeight
                    container!.scrollTo({
                        top: targetScrollTop,
                        left: 0,
                        behavior: "auto",
                    })
                    lastUpdatedScrollTop = targetScrollTop
                } else {
                    container!.scrollTo({
                        top: 0,
                        left: 0,
                        behavior: "auto",
                    })
                    lastUpdatedScrollTop = 0
                }
            }
            lastObservedPage = currentPage
            hasRestoredScroll = true
        })
    })

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
                onNavigate: (targetPage) => {
                    void commandsStore.execute("viewer.page.go-to", {
                        page: targetPage,
                        isJump: true,
                    })
                },
            })
            if (signal?.aborted) return

            if (textContainer === textLayer1) {
                cachedSpanRanges1 = buildSpanRanges(textContainer)
                textLayer1RenderCount += 1
            } else if (textContainer === textLayer2) {
                cachedSpanRanges2 = buildSpanRanges(textContainer)
                textLayer2RenderCount += 1
            }
        } catch (err) {
            if (signal?.aborted) return
            console.error(
                `[CanvasPane] Failed to render page layers for page ${pageNo}`,
                getViewerDocumentErrorDiagnostic(err, "Unable to render document layers"),
            )
        }
    }

    let textLayerController1: AbortController | null = null
    let textLayerController2: AbortController | null = null

    $effect(() => {
        if (!renderLayers || !pdf || layoutMode === "scroll" || isPageLoading) return
        const targetPdf = pdf
        const tLayer1 = textLayer1
        const aLayer1 = annotationLayer1
        const page = currentPage
        if (tLayer1 && aLayer1) {
            textLayerController1?.abort()
            const controller = new AbortController()
            textLayerController1 = controller
            const delayTimeout = setTimeout(() => {
                renderPageLayers(targetPdf, page, tLayer1, aLayer1, controller.signal)
            }, 150)
            return () => {
                clearTimeout(delayTimeout)
                controller.abort()
            }
        }
    })

    $effect(() => {
        if (!renderLayers || !pdf || layoutMode !== "split" || isPageLoading) return
        const targetPdf = pdf
        const tLayer2 = textLayer2
        const aLayer2 = annotationLayer2
        const page = currentPage + 1
        if (tLayer2 && aLayer2) {
            textLayerController2?.abort()
            const controller = new AbortController()
            textLayerController2 = controller
            const delayTimeout = setTimeout(() => {
                renderPageLayers(targetPdf, page, tLayer2, aLayer2, controller.signal)
            }, 150)
            return () => {
                clearTimeout(delayTimeout)
                controller.abort()
            }
        }
    })

    function highlightPage(pageNumber: number, cacheKey: 1 | 2) {
        const matches = searchStore.matches.filter((m) => m.pageNumber === pageNumber)
        const ranges: Range[] = []

        if (matches.length > 0) {
            const spanRanges = cacheKey === 1 ? cachedSpanRanges1 : cachedSpanRanges2

            if (spanRanges) {
                matches.forEach((match) => {
                    const startEntry = findSpanByOffset(spanRanges, match.start)
                    const endEntry = findSpanByOffset(spanRanges, match.end)

                    if (startEntry && endEntry) {
                        try {
                            const range = new Range()
                            range.setStart(startEntry.textNode, match.start - startEntry.start)
                            range.setEnd(endEntry.textNode, match.end - endEntry.start)
                            ranges.push(range)
                        } catch (e) {
                            console.error("[CanvasPane] Failed to create highlight range:", e)
                            ranges.push(null as any) // Keep index aligned
                        }
                    }
                })
            }
        }

        searchStore.registerPageRanges(pageNumber, ranges)
    }

    function scrollToActiveRange(range: Range) {
        requestAnimationFrame(() => {
            const currentContainer = container
            if (!currentContainer) return

            let rangeRect = range.getBoundingClientRect()
            if (rangeRect.width === 0 || rangeRect.height === 0) {
                requestAnimationFrame(() => {
                    rangeRect = range.getBoundingClientRect()
                    if (rangeRect.width > 0 && rangeRect.height > 0) {
                        performScroll(currentContainer, rangeRect)
                    }
                })
            } else {
                performScroll(currentContainer, rangeRect)
            }
        })
    }

    function performScroll(container: HTMLElement, rangeRect: DOMRect) {
        const containerRect = container.getBoundingClientRect()
        const rangeTopInContainer = rangeRect.top - containerRect.top + container.scrollTop
        const rangeLeftInContainer = rangeRect.left - containerRect.left + container.scrollLeft

        const targetScrollTop =
            rangeTopInContainer - container.clientHeight / 2 + rangeRect.height / 2
        const targetScrollLeft =
            rangeLeftInContainer - container.clientWidth / 2 + rangeRect.width / 2

        const behavior = settingsStore.animations ? "smooth" : "auto"
        container.scrollTo({
            top: targetScrollTop,
            left: targetScrollLeft,
            behavior,
        })
    }

    $effect(() => {
        if (!renderLayers || layoutMode === "scroll") return

        void textLayer1RenderCount
        void searchStore.matches
        const pageNo = currentPage

        untrack(() => {
            if (textLayer1 && pdf && !isPageLoading) {
                highlightPage(pageNo, 1)
            }
        })
        return () => {
            untrack(() => {
                searchStore.unregisterPageRanges(pageNo)
            })
        }
    })

    $effect(() => {
        if (!renderLayers || layoutMode !== "split") return

        void textLayer2RenderCount
        void searchStore.matches
        const pageNo = currentPage + 1

        untrack(() => {
            if (textLayer2 && pdf && !isPageLoading) {
                highlightPage(pageNo, 2)
            }
        })
        return () => {
            untrack(() => {
                searchStore.unregisterPageRanges(pageNo)
            })
        }
    })

    function highlightNotes(pageNo: number, cacheKey: 1 | 2) {
        const pageNotes = notesStore.notes.filter((n) => n.pageNumber === pageNo)
        const noteRanges: { noteId: string; range: Range; color: string }[] = []

        if (pageNotes.length > 0) {
            const spanRanges = cacheKey === 1 ? cachedSpanRanges1 : cachedSpanRanges2

            if (spanRanges) {
                pageNotes.forEach((note) => {
                    const startEntry = findSpanByOffset(spanRanges, note.start)
                    const endEntry = findSpanByOffset(spanRanges, note.end)

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

                            // Handle scroll to note
                            if (notesStore.scrollingToNoteId === note.id) {
                                scrollToActiveRange(range)
                                notesStore.scrollingToNoteId = null
                            }
                        } catch (e) {
                            console.error("[CanvasPane] Failed to create note range:", e)
                        }
                    }
                })
            }
        }

        notesStore.registerPageRanges(pageNo, noteRanges)
    }

    $effect(() => {
        if (!renderLayers || layoutMode === "scroll") return

        void textLayer1RenderCount
        void notesStore.notes
        const pageNo = currentPage

        untrack(() => {
            if (textLayer1 && pdf && !isPageLoading) {
                highlightNotes(pageNo, 1)
            }
        })
        return () => {
            untrack(() => {
                notesStore.unregisterPageRanges(pageNo)
            })
        }
    })

    $effect(() => {
        if (!renderLayers || layoutMode !== "split") return

        void textLayer2RenderCount
        void notesStore.notes
        const pageNo = currentPage + 1

        untrack(() => {
            if (textLayer2 && pdf && !isPageLoading) {
                highlightNotes(pageNo, 2)
            }
        })
        return () => {
            untrack(() => {
                notesStore.unregisterPageRanges(pageNo)
            })
        }
    })

    // One document-level selection listener serves single, split, and virtualized scroll pages.
    $effect(() => {
        if (!browser || !pdf) return

        const handleSelectionChange = () => {
            const selection = document.getSelection()
            const currentBook = viewerStore.getCurrentBook()
            if (!currentBook) return

            if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
                if (notesStore.activeSelection?.bookId === currentBook.id) {
                    notesStore.activeSelection = null
                }
                return
            }

            const range = selection.getRangeAt(0)
            let selectedPage: number | null = null
            let spans: SpanRange[] | null = null

            if (layoutMode === "scroll") {
                for (const [pageNumber, page] of scrollSelectionPages) {
                    if (
                        page.container.contains(range.startContainer) &&
                        page.container.contains(range.endContainer)
                    ) {
                        selectedPage = pageNumber
                        spans = page.getSpanRanges()
                        break
                    }
                }
            } else if (
                textLayer1?.contains(range.startContainer) &&
                textLayer1.contains(range.endContainer)
            ) {
                selectedPage = currentPage
                spans = cachedSpanRanges1
            } else if (
                textLayer2?.contains(range.startContainer) &&
                textLayer2.contains(range.endContainer)
            ) {
                selectedPage = currentPage + 1
                spans = cachedSpanRanges2
            }

            if (selectedPage !== null && spans) {
                const startOffset = getGlobalOffset(range.startContainer, range.startOffset, spans)
                const endOffset = getGlobalOffset(range.endContainer, range.endOffset, spans)
                if (startOffset !== null && endOffset !== null) {
                    const rect = range.getBoundingClientRect()
                    notesStore.activeSelection = {
                        bookId: currentBook.id,
                        pageNumber: selectedPage,
                        start: Math.min(startOffset, endOffset),
                        end: Math.max(startOffset, endOffset),
                        text: selection.toString(),
                        x: rect.left + rect.width / 2,
                        y: rect.top,
                        bottomY: rect.bottom,
                    }
                }
            }
        }

        const handleTextLayerClick = (e: MouseEvent) => {
            const target = e.target as HTMLElement
            const textLayer = target.closest(".textLayer") as HTMLElement
            if (!textLayer) return

            const pageAttr = textLayer.getAttribute("data-page")
            if (!pageAttr) return
            const pageNo = parseInt(pageAttr, 10)

            let spans: SpanRange[] | null = null
            if (textLayer === textLayer1) spans = cachedSpanRanges1
            else if (textLayer === textLayer2) spans = cachedSpanRanges2

            if (spans) {
                const clickOffset = getOffsetFromPoint(e, textLayer, spans)
                if (clickOffset !== null) {
                    const currentBook = viewerStore.getCurrentBook()
                    if (!currentBook) return

                    const clickedNote = notesStore.notes.find(
                        (n) =>
                            n.bookId === currentBook.id &&
                            n.pageNumber === pageNo &&
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
        }

        document.addEventListener("selectionchange", handleSelectionChange)
        const currentContainer = container
        if (currentContainer) {
            currentContainer.addEventListener("click", handleTextLayerClick)
        }

        return () => {
            document.removeEventListener("selectionchange", handleSelectionChange)
            if (currentContainer) {
                currentContainer.removeEventListener("click", handleTextLayerClick)
            }
        }
    })

    $effect(() => {
        if (!searchStore.isActive || promptStore.isOpen) return

        const activeRange = searchStore.activeRange
        if (activeRange && container) {
            scrollToActiveRange(activeRange)
        }
    })
</script>

{#snippet scrollView()}
    {#if pdf && pageOffsets.length > 0}
        <div class="virtual-container" style="height: {totalHeight}px;">
            {#each visibleRange as i (i)}
                <ScrollPage
                    {pdf}
                    {registerSelectionPage}
                    pageNumber={i + 1}
                    scale={getScrollPageScale(pageDimensions[i])}
                    offsetY={pageOffsets[i]}
                    width={pageDimensions[i].width * getScrollPageScale(pageDimensions[i])}
                    height={getPageHeight(pageDimensions[i])}
                />
            {/each}
        </div>
    {/if}
{/snippet}

{#snippet singleSplitView()}
    {#if isPageLoading}
        <div class="pane-loader">
            <Spinner variant="dots" size="lg" label={m.rendering_page()} />
        </div>
    {:else if currentPageImage}
        <div class="pages-container" class:split-mode={layoutMode === "split"}>
            {#if layoutMode === "split" && currentPageImage2}
                <div class="book-spread">
                    <div class="pdf-image-wrapper split-left" style={wrapperStyle1}>
                        <img
                            src={currentPageImage}
                            alt={m.page_render_alt({ page: currentPage })}
                            class="pdf-image"
                        />
                        {#if renderLayers}
                            <div
                                bind:this={textLayer1}
                                class="textLayer"
                                data-page={currentPage}
                            ></div>
                            <div bind:this={annotationLayer1} class="annotationLayer"></div>
                        {/if}
                    </div>
                    <div class="book-spine"></div>
                    <div class="pdf-image-wrapper split-right" style={wrapperStyle2}>
                        <img
                            src={currentPageImage2}
                            alt={m.page_render_alt({ page: currentPage + 1 })}
                            class="pdf-image"
                        />
                        {#if renderLayers}
                            <div
                                bind:this={textLayer2}
                                class="textLayer"
                                data-page={currentPage + 1}
                            ></div>
                            <div bind:this={annotationLayer2} class="annotationLayer"></div>
                        {/if}
                    </div>
                </div>
            {:else}
                <div class="pdf-image-wrapper" style={wrapperStyle1}>
                    <img
                        src={currentPageImage}
                        alt={m.page_render_alt({ page: currentPage })}
                        class="pdf-image"
                    />
                    {#if renderLayers}
                        <div bind:this={textLayer1} class="textLayer" data-page={currentPage}></div>
                        <div bind:this={annotationLayer1} class="annotationLayer"></div>
                    {/if}
                </div>
            {/if}
        </div>
    {/if}
{/snippet}

<div
    class="canvas-pane"
    class:scroll-mode={layoutMode === "scroll"}
    class:mobile-full-width={isCompactPortrait}
    class:single-layout={layoutMode === "single"}
    class:compact-mode={viewport.isCompact}
    class:animations-enabled={settingsStore.animations}
>
    <div
        class="canvas-frame"
        bind:this={container}
        bind:clientHeight={containerHeight}
        bind:clientWidth={() => containerWidth, updateContainerWidth}
        onscroll={handleScroll}
        onscrollend={() => {
            if (isAutoScrolling) {
                isAutoScrolling = false
                if (autoScrollTimeout) clearTimeout(autoScrollTimeout)
            }
            // Sync final exact scroll state when scroll ends
            if (container && hasRestoredScroll && !isResizeRestoring) {
                syncScrollState(container.scrollTop, container.clientHeight, container.scrollHeight)
            }
        }}
    >
        {#if layoutMode === "scroll"}
            {@render scrollView()}
        {:else}
            {@render singleSplitView()}
        {/if}
    </div>
</div>

<style>
    .canvas-pane {
        display: flex;
        flex-direction: column;
        height: 100%;
        box-sizing: border-box;
        overflow: hidden;
        background: var(--canvas-bg-color);
        width: 100%;
        flex: 1;
    }

    .canvas-pane.compact-mode {
        background: transparent;
    }

    .canvas-pane.compact-mode .canvas-frame {
        background: transparent;
        background-image: none;
        box-shadow: none;
        padding: 0 !important;
    }

    .canvas-frame {
        flex: 1;
        background: var(--canvas-bg-color);
        box-shadow: inset 3px 3px 0 rgba(0, 0, 0, 0.05);
        overflow: auto;
        display: flex;
        justify-content: safe center;
        align-items: flex-start;
        position: relative;
        padding: 40px;
    }

    /* Scroll Mode overrides */
    .canvas-pane.scroll-mode .canvas-frame {
        display: block;
        padding: 0;
    }

    .canvas-pane.scroll-mode .canvas-frame::-webkit-scrollbar {
        width: 10px;
    }

    .canvas-pane.scroll-mode .canvas-frame::-webkit-scrollbar-track {
        background: var(--surface-hover-color);
    }

    .canvas-pane.scroll-mode .canvas-frame::-webkit-scrollbar-thumb {
        background: var(--accent-color);
        border: 2px solid var(--surface-hover-color);
    }

    @media (hover: hover) {
        .canvas-pane.scroll-mode .canvas-frame::-webkit-scrollbar-thumb:hover {
            background: var(--accent-active-color);
        }
    }

    .virtual-container {
        position: relative;
        width: 100%;
    }

    .pages-container {
        display: flex;
        gap: 24px;
        align-items: flex-start;
        justify-content: safe center;
    }

    .pages-container.split-mode {
        gap: 32px;
    }

    .pane-loader {
        display: flex;
        align-items: center;
        justify-content: center;
        position: absolute;
        inset: 0;
        background: var(--overlay-color);
        backdrop-filter: none;
        z-index: var(--z-10);
    }

    .pdf-image-wrapper {
        border: var(--border-elevated) solid var(--border-color);
        box-shadow: var(--shadow-elevated);
        display: inline-flex;
        position: relative;
        transform-origin: top center;
    }

    .canvas-pane.animations-enabled .pdf-image-wrapper {
        transition:
            width 0.16s cubic-bezier(0.4, 0, 0.2, 1),
            height 0.16s cubic-bezier(0.4, 0, 0.2, 1),
            transform 0.16s cubic-bezier(0.4, 0, 0.2, 1);
    }

    .pdf-image {
        display: block;
        width: 100%;
        height: 100%;
    }

    :global(html.dark) .pdf-image {
        filter: invert(1) hue-rotate(180deg);
    }

    @media (--desktop) {
        .canvas-frame {
            padding: 16px;
        }

        .canvas-pane.scroll-mode .canvas-frame {
            padding: 0;
        }

        .pages-container,
        .pages-container.split-mode {
            gap: 16px;
        }
    }

    .canvas-pane.mobile-full-width {
        padding: 0;
    }

    .canvas-pane.mobile-full-width.scroll-mode {
        padding: 0;
    }

    .canvas-pane.mobile-full-width .canvas-frame {
        padding: 0;
        border-width: 0;
    }

    .canvas-pane.mobile-full-width.single-layout .canvas-frame {
        align-items: safe center;
        justify-content: center;
    }

    .canvas-pane.mobile-full-width.scroll-mode .canvas-frame {
        padding: 0;
        border-width: 0;
    }

    .canvas-pane.mobile-full-width .pdf-image-wrapper {
        max-width: 100%;
        border-width: 0;
        box-shadow: none;
        border-bottom: none !important;
    }

    .canvas-pane.mobile-full-width .pages-container:not(.split-mode) {
        width: 100%;
        gap: 0;
        display: flex;
        flex-direction: column;
        align-items: center;
    }

    /* Mobile full width split layout (book spread) */
    .canvas-pane.mobile-full-width .pages-container.split-mode {
        width: 100%;
        gap: 0;
        padding: 0;
    }

    .canvas-pane.mobile-full-width .book-spread {
        border-width: 0;
        border-bottom: none;
        box-shadow: none;
    }

    .canvas-pane.mobile-full-width .book-spread .pdf-image-wrapper {
        border-bottom: none !important;
    }

    /* Book Spread joined layout */
    .book-spread {
        display: flex;
        position: relative;
        align-items: flex-start;
        box-shadow: var(--shadow-elevated);
        border: var(--border-elevated) solid var(--border-color);
        background: var(--canvas-bg-color);
    }

    .book-spread .pdf-image-wrapper {
        border: none;
        box-shadow: none;
    }

    .book-spread .split-left {
        border-right: 1px solid rgba(0, 0, 0, 0.12);
    }

    :global(html.dark) .book-spread .split-left {
        border-right-color: rgba(255, 255, 255, 0.12);
    }

    .book-spine {
        position: absolute;
        top: 0;
        bottom: 0;
        left: 50%;
        width: 32px;
        transform: translateX(-50%);
        pointer-events: none;
        z-index: var(--z-5);
        background: linear-gradient(
            to right,
            rgba(0, 0, 0, 0) 0%,
            rgba(0, 0, 0, 0.05) 30%,
            rgba(0, 0, 0, 0.12) 48%,
            rgba(0, 0, 0, 0.18) 50%,
            rgba(0, 0, 0, 0.12) 52%,
            rgba(0, 0, 0, 0.05) 70%,
            rgba(0, 0, 0, 0) 100%
        );
    }

    @media (prefers-reduced-motion: reduce) {
        .canvas-pane.animations-enabled .pdf-image-wrapper {
            transition: none;
        }
    }

    :global(html.dark) .book-spine {
        background: linear-gradient(
            to right,
            rgba(0, 0, 0, 0) 0%,
            rgba(0, 0, 0, 0.15) 30%,
            rgba(0, 0, 0, 0.35) 48%,
            rgba(0, 0, 0, 0.5) 50%,
            rgba(0, 0, 0, 0.35) 52%,
            rgba(0, 0, 0, 0.15) 70%,
            rgba(0, 0, 0, 0) 100%
        );
    }
</style>
