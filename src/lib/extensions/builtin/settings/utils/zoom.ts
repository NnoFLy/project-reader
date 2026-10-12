export function stepAndClampScale(
    currentScale: number,
    direction: -1 | 1,
    minScale: number,
    maxScale: number,
): number {
    const steppedScale = Math.round((currentScale + direction * 0.1) * 10) / 10
    return Math.max(minScale, Math.min(maxScale, steppedScale))
}
