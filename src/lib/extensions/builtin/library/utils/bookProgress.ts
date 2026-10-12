export function formatBookProgress(
    pageNumber: number | undefined,
    totalPages: number | undefined,
    formatTotal: (total: number) => string,
): string | undefined {
    if (!Number.isInteger(totalPages) || (totalPages ?? 0) <= 0) return undefined

    const total = totalPages as number
    const totalLabel = formatTotal(total)
    if (!Number.isInteger(pageNumber) || (pageNumber ?? 0) <= 0 || (pageNumber as number) > total) {
        return totalLabel
    }

    return `${pageNumber} ${totalLabel}`
}
