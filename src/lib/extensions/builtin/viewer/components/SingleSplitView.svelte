<script lang="ts">
    import * as m from "$lib/paraglide/messages"
    import Spinner from "$lib/shared/ui/Spinner.svelte"
    import type { ViewerPagedDocument } from "../viewerDocument"
    import PageView from "./PageView.svelte"

    let {
        pdf,
        isPageLoading,
        layoutMode,
        currentPage,
        currentPageImage,
        currentPageImage2,
        wrapperStyle1,
        wrapperStyle2,
        pageScale1,
        pageScale2,
        renderLayers,
    } = $props<{
        pdf: ViewerPagedDocument | null
        isPageLoading: boolean
        layoutMode: "single" | "split"
        currentPage: number
        currentPageImage: string | null
        currentPageImage2: string | null
        wrapperStyle1: string
        wrapperStyle2: string
        pageScale1: number
        pageScale2: number
        renderLayers: boolean
    }>()

    function getDimFromStyle(style: string) {
        const wMatch = style.match(/width:\s*([\d.]+)px/)
        const hMatch = style.match(/height:\s*([\d.]+)px/)
        return {
            width: wMatch ? parseFloat(wMatch[1]) : 0,
            height: hMatch ? parseFloat(hMatch[1]) : 0,
        }
    }

    const dim1 = $derived(getDimFromStyle(wrapperStyle1))
    const dim2 = $derived(getDimFromStyle(wrapperStyle2))
</script>

{#if isPageLoading}
    <div class="pane-loader">
        <Spinner variant="dots" size="lg" label={m.rendering_page()} />
    </div>
{:else if currentPageImage}
    <div class="pages-container" class:split-mode={layoutMode === "split"}>
        {#if layoutMode === "split" && currentPageImage2}
            <div class="book-spread">
                <PageView
                    {pdf}
                    pageNumber={currentPage}
                    image={currentPageImage}
                    width={dim1.width}
                    height={dim1.height}
                    scale={pageScale1}
                    {renderLayers}
                    class="split-left"
                />
                <div class="book-spine"></div>
                <PageView
                    {pdf}
                    pageNumber={currentPage + 1}
                    image={currentPageImage2}
                    width={dim2.width}
                    height={dim2.height}
                    scale={pageScale2}
                    {renderLayers}
                    class="split-right"
                />
            </div>
        {:else}
            <PageView
                {pdf}
                pageNumber={currentPage}
                image={currentPageImage}
                width={dim1.width}
                height={dim1.height}
                scale={pageScale1}
                {renderLayers}
            />
        {/if}
    </div>
{/if}

<style>
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

    .book-spread {
        display: flex;
        position: relative;
        align-items: flex-start;
        box-shadow: var(--shadow-elevated);
        border: var(--border-elevated) solid var(--border-color);
        background: var(--canvas-bg-color);
    }

    :global(.book-spread .pdf-image-wrapper) {
        border: none !important;
        box-shadow: none !important;
    }

    :global(.book-spread .split-left) {
        border-right: 1px solid rgba(0, 0, 0, 0.12) !important;
    }

    :global(html.dark .book-spread .split-left) {
        border-right-color: rgba(255, 255, 255, 0.12) !important;
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
</style>
