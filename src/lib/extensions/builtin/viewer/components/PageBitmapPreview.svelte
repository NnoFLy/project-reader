<script lang="ts">
    import * as m from "$lib/paraglide/messages"
    import { getBitmapPageScale, getBitmapWrapperStyle } from "./pageBitmapGeometry"

    let {
        currentPage,
        currentPageImage,
        currentPageImage2 = null,
        currentPageDim1,
        currentPageDim2 = null,
        layoutMode,
        effectiveScale,
        defaultScale,
        defaultPageDimension,
        isCompactPortrait,
    } = $props<{
        currentPage: number
        currentPageImage: string
        currentPageImage2?: string | null
        currentPageDim1: { width: number; height: number }
        currentPageDim2?: { width: number; height: number } | null
        layoutMode: "single" | "split"
        effectiveScale: number
        defaultScale: number
        defaultPageDimension: { width: number; height: number }
        isCompactPortrait: boolean
    }>()

    let containerWidth = $state(0)
    const pageScale1 = $derived(
        getBitmapPageScale({
            containerWidth,
            dimension: currentPageDim1,
            otherDimension:
                layoutMode === "split"
                    ? (currentPageDim2 ?? defaultPageDimension)
                    : currentPageDim2,
            layout: layoutMode,
            effectiveScale,
            defaultScale,
            compact: true,
        }),
    )
    const pageScale2 = $derived(
        currentPageDim2
            ? getBitmapPageScale({
                  containerWidth,
                  dimension: currentPageDim2,
                  otherDimension: currentPageDim1,
                  layout: layoutMode,
                  effectiveScale,
                  defaultScale,
                  compact: true,
              })
            : effectiveScale,
    )
    const wrapperStyle1 = $derived(getBitmapWrapperStyle(currentPageDim1, pageScale1))
    const wrapperStyle2 = $derived(
        currentPageDim2 ? getBitmapWrapperStyle(currentPageDim2, pageScale2) : "",
    )
</script>

<div class="page-bitmap-preview">
    <div
        class={[
            "preview-frame",
            isCompactPortrait && "compact-portrait",
            isCompactPortrait && layoutMode === "single" && "compact-portrait-single",
        ]}
        bind:clientWidth={containerWidth}
    >
        <div class={["pages-container", layoutMode === "split" && "split-mode"]}>
            {#if layoutMode === "split" && currentPageImage2 && currentPageDim2}
                <div class="book-spread">
                    <div class="pdf-image-wrapper split-left" style={wrapperStyle1}>
                        <img
                            src={currentPageImage}
                            alt={m.page_render_alt({ page: currentPage })}
                            class="pdf-image"
                        />
                    </div>
                    <div class="book-spine"></div>
                    <div class="pdf-image-wrapper split-right" style={wrapperStyle2}>
                        <img
                            src={currentPageImage2}
                            alt={m.page_render_alt({ page: currentPage + 1 })}
                            class="pdf-image"
                        />
                    </div>
                </div>
            {:else}
                <div class="pdf-image-wrapper" style={wrapperStyle1}>
                    <img
                        src={currentPageImage}
                        alt={m.page_render_alt({ page: currentPage })}
                        class="pdf-image"
                    />
                </div>
            {/if}
        </div>
    </div>
</div>

<style>
    .page-bitmap-preview {
        display: flex;
        flex: 1;
        width: 100%;
        height: 100%;
        min-width: 0;
        min-height: 0;
        overflow: hidden;
        background: transparent;
    }

    .preview-frame {
        display: flex;
        flex: 1;
        width: 100%;
        min-width: 0;
        min-height: 0;
        padding: 0;
        align-items: flex-start;
        justify-content: safe center;
        position: relative;
        overflow: hidden;
    }

    .preview-frame.compact-portrait-single {
        align-items: safe center;
    }

    .pages-container {
        display: flex;
        width: 100%;
        gap: 24px;
        align-items: flex-start;
        justify-content: safe center;
    }

    .pages-container.split-mode {
        gap: 32px;
    }

    .pages-container:not(.split-mode) {
        flex-direction: column;
        align-items: center;
    }

    .pdf-image-wrapper {
        display: inline-flex;
        position: relative;
        border: 3px solid var(--border-color);
        box-shadow: 12px 12px 0 var(--shadow-color);
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

    .book-spread {
        display: flex;
        position: relative;
        align-items: flex-start;
        border: 3px solid var(--border-color);
        box-shadow: 12px 12px 0 var(--shadow-color);
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

    @media (--desktop) {
        .pages-container,
        .pages-container.split-mode {
            gap: 16px;
        }
    }

    .preview-frame.compact-portrait .pdf-image-wrapper {
        border-width: 0;
        box-shadow: none;
        border-bottom: none;
    }

    .preview-frame.compact-portrait .pages-container,
    .preview-frame.compact-portrait .pages-container.split-mode {
        gap: 0;
    }

    .preview-frame.compact-portrait .book-spread {
        border-width: 0;
        border-bottom: none;
        box-shadow: none;
    }
</style>
