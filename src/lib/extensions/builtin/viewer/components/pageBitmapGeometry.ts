export interface PageBitmapDimension {
    width: number
    height: number
}

export function getBitmapPageScale({
    containerWidth,
    dimension,
    otherDimension,
    layout,
    effectiveScale,
    defaultScale,
    compact,
}: {
    containerWidth: number
    dimension: PageBitmapDimension
    otherDimension?: PageBitmapDimension | null
    layout: "single" | "split"
    effectiveScale: number
    defaultScale: number
    compact: boolean
}): number {
    if (!compact || containerWidth <= 0) return effectiveScale

    const totalWidth =
        layout === "split" && otherDimension
            ? dimension.width + otherDimension.width
            : dimension.width
    return (containerWidth / totalWidth) * (effectiveScale / defaultScale)
}

export function getBitmapWrapperStyle(dimension: PageBitmapDimension, scale: number): string {
    return `width: ${dimension.width * scale}px; height: ${dimension.height * scale}px; --aspect-ratio: ${dimension.width} / ${dimension.height}; --display-scale: ${scale};`
}
