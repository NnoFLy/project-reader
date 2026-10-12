import type { ViewerPagedDocument } from "../viewerDocument"
import {
    executePageRenderPlan,
    type PageRenderPlanEntry,
    type PageRenderRole,
} from "./pageSliderPolicy"

export interface BookViewerBitmapResult {
    pageNumber: number
    image: string
    dimension: { width: number; height: number } | null
}

type BitmapDocument = Pick<ViewerPagedDocument, "renderPage" | "getPage">

export async function renderBookViewerBitmaps({
    pdf,
    quality,
    plan,
    signal,
    skipCurrent = false,
    publish,
    onBackgroundError,
}: {
    pdf: BitmapDocument
    quality: number
    plan: readonly PageRenderPlanEntry[]
    signal: AbortSignal
    skipCurrent?: boolean
    publish: (
        role: Exclude<PageRenderRole, "lookahead">,
        results: readonly BookViewerBitmapResult[],
    ) => void
    onBackgroundError?: (error: unknown, role: Exclude<PageRenderRole, "current">) => void
}): Promise<void> {
    await executePageRenderPlan({
        plan,
        signal,
        skipCurrent,
        render: async (pageNumber, renderSignal, role) => {
            const rendered = await pdf.renderPage(pageNumber, {
                quality,
                signal: renderSignal,
            })
            const dimension = role === "lookahead" ? null : await pdf.getPage(pageNumber)
            return { pageNumber, image: rendered.url, dimension }
        },
        publish,
        onBackgroundError,
    })
}
