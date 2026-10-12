import type { SliderDirection } from "$lib/shared/ui/slider"

export type PageLayout = "single" | "split"
export type PageRenderRole = "current" | "previous" | "next" | "lookahead"

export interface PageRenderPlanEntry {
    pageNumber: number
    roles: PageRenderRole[]
}

export function getPageTarget(
    currentPage: number,
    totalPages: number,
    layout: PageLayout,
    direction: SliderDirection,
): number | undefined {
    if (totalPages < 1 || currentPage < 1 || currentPage > totalPages) return undefined

    if (direction === "previous") {
        if (currentPage <= 1) return undefined
        return Math.max(1, currentPage - (layout === "split" ? 2 : 1))
    }

    if (layout === "split") {
        if (currentPage + 1 >= totalPages) return undefined
        return Math.min(totalPages, currentPage + 2)
    }

    return currentPage < totalPages ? currentPage + 1 : undefined
}

export function getSpreadPages(
    anchorPage: number,
    totalPages: number,
    layout: PageLayout,
): number[] {
    if (anchorPage < 1 || anchorPage > totalPages) return []
    if (layout === "split" && anchorPage + 1 <= totalPages) {
        return [anchorPage, anchorPage + 1]
    }
    return [anchorPage]
}

export function createPageRenderPlan({
    currentPage,
    totalPages,
    layout,
    includeAdjacent,
}: {
    currentPage: number
    totalPages: number
    layout: PageLayout
    includeAdjacent: boolean
}): PageRenderPlanEntry[] {
    const plan: PageRenderPlanEntry[] = []
    const entriesByPage = new Map<number, PageRenderPlanEntry>()

    const addSpread = (anchor: number | undefined, role: PageRenderRole) => {
        if (anchor === undefined) return
        for (const pageNumber of getSpreadPages(anchor, totalPages, layout)) {
            const existing = entriesByPage.get(pageNumber)
            if (existing) {
                if (!existing.roles.includes(role)) existing.roles.push(role)
                continue
            }
            const entry = { pageNumber, roles: [role] }
            entriesByPage.set(pageNumber, entry)
            plan.push(entry)
        }
    }

    addSpread(currentPage, "current")

    const previous = getPageTarget(currentPage, totalPages, layout, "previous")
    const next = getPageTarget(currentPage, totalPages, layout, "next")
    if (includeAdjacent) {
        addSpread(previous, "previous")
        addSpread(next, "next")
        const lookahead =
            next === undefined ? undefined : getPageTarget(next, totalPages, layout, "next")
        addSpread(lookahead, "lookahead")
    } else {
        addSpread(next, "lookahead")
    }

    return plan
}

export async function executePageRenderPlan<T>({
    plan,
    signal,
    skipCurrent = false,
    render,
    publish,
    onBackgroundError,
}: {
    plan: readonly PageRenderPlanEntry[]
    signal: AbortSignal
    skipCurrent?: boolean
    render: (pageNumber: number, signal: AbortSignal, role: PageRenderRole) => Promise<T>
    publish: (role: Exclude<PageRenderRole, "lookahead">, results: readonly T[]) => void
    onBackgroundError?: (error: unknown, role: Exclude<PageRenderRole, "current">) => void
}): Promise<void> {
    const roles: readonly PageRenderRole[] = ["current", "previous", "next", "lookahead"]
    const rendered = new Map<number, T>()

    for (const role of roles) {
        if (signal.aborted) return
        if (role === "current" && skipCurrent) continue

        const entries = plan
            .filter((entry) => entry.roles.includes(role))
            .toSorted((a, b) => a.pageNumber - b.pageNumber)
        if (entries.length === 0) continue

        try {
            const results: T[] = []
            for (const entry of entries) {
                let result = rendered.get(entry.pageNumber)
                if (result === undefined) {
                    result = await render(entry.pageNumber, signal, role)
                    rendered.set(entry.pageNumber, result)
                }
                results.push(result)
                if (signal.aborted) return
            }
            if (role !== "lookahead" && !signal.aborted) publish(role, results)
        } catch (error) {
            if (signal.aborted) return
            if (role === "current") throw error
            onBackgroundError?.(error, role)
        }
    }
}
