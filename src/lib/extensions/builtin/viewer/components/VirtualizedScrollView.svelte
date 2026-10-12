<script lang="ts">
    import { viewport } from "$lib/shared/state/viewport.svelte"
    import type { ViewerPagedDocument } from "../viewerDocument"
    import ScrollPage from "./ScrollPage.svelte"

    let {
        pdf,
        pageDimensions,
        pageOffsets,
        visibleRange,
        containerWidth,
        scale,
        isShortHeight,
        totalHeight,
        getPageHeight,
        PAGE_GAP,
    } = $props<{
        pdf: ViewerPagedDocument | null
        pageDimensions: { width: number; height: number }[]
        pageOffsets: number[]
        visibleRange: number[]
        containerWidth: number
        scale: number
        isShortHeight: boolean
        totalHeight: number
        getPageHeight: (dim: { width: number; height: number }) => number
        PAGE_GAP: number
    }>()
</script>

{#if pdf && pageOffsets.length > 0}
    <div class="virtual-container" style="height: {totalHeight}px;">
        {#each visibleRange as i (i)}
            <ScrollPage
                {pdf}
                pageNumber={i + 1}
                scale={viewport.isCompact
                    ? (containerWidth / pageDimensions[i].width) * (isShortHeight ? scale / 1.5 : 1)
                    : scale}
                offsetY={pageOffsets[i]}
                width={viewport.isCompact
                    ? containerWidth * (isShortHeight ? scale / 1.5 : 1)
                    : pageDimensions[i].width * scale}
                height={getPageHeight(pageDimensions[i])}
            />
        {/each}
    </div>
{/if}

<style>
    .virtual-container {
        position: relative;
        width: 100%;
    }
</style>
