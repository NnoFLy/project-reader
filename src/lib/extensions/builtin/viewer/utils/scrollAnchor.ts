export interface ScrollAnchor {
    page: number
    offsetRatio: number
}

export function captureScrollAnchor(
    page: number,
    scrollTop: number,
    viewportHeight: number,
    pageOffsets: readonly number[],
    pageHeights: readonly number[],
): ScrollAnchor | null {
    const pageIndex = Math.min(Math.max(0, page - 1), pageOffsets.length - 1)
    const pageTop = pageOffsets[pageIndex]
    const pageHeight = pageHeights[pageIndex]
    if (pageTop === undefined || !pageHeight || pageHeight <= 0) return null

    return {
        page: pageIndex + 1,
        offsetRatio: (scrollTop + viewportHeight / 2 - pageTop) / pageHeight,
    }
}

export function restoreScrollAnchor(
    anchor: ScrollAnchor,
    viewportHeight: number,
    pageOffsets: readonly number[],
    pageHeights: readonly number[],
    maxScrollTop = Number.POSITIVE_INFINITY,
): number {
    const pageIndex = Math.min(Math.max(0, anchor.page - 1), pageOffsets.length - 1)
    const pageTop = pageOffsets[pageIndex] ?? 0
    const pageHeight = pageHeights[pageIndex] ?? 0
    const target = pageTop + anchor.offsetRatio * pageHeight - viewportHeight / 2
    return Math.max(0, Math.min(target, Math.max(0, maxScrollTop)))
}
