<script lang="ts">
    import type { Snippet } from "svelte"
    import { cubicOut } from "svelte/easing"
    import { onMount } from "svelte"
    import { getFocusableElements, restoreFocus, trapTabKey } from "../modal/modalFocus"

    let {
        side = "left",
        presentation = "overlay",
        showBackdrop = presentation === "overlay",
        backdropLabel = "Close sidebar",
        onClose,
        onMouseLeave,
        duration = 150,
        width,
        ariaLabel = "Sidebar",
        header,
        search,
        children,
        footer,
    } = $props<{
        side?: "left" | "right"
        presentation?: "docked" | "overlay"
        showBackdrop?: boolean
        backdropLabel?: string
        onClose?: () => void
        onMouseLeave?: (event: MouseEvent) => void
        duration?: number
        width?: string
        ariaLabel?: string
        header?: Snippet
        search?: Snippet
        children: Snippet
        footer?: Snippet
    }>()

    let returnFocus: HTMLElement | null = null
    let sidebarRef = $state<HTMLElement | null>(null)

    const isModalOverlay = $derived(presentation === "overlay" && showBackdrop)

    function handleKeydown(event: KeyboardEvent) {
        if (!isModalOverlay || !sidebarRef) return
        trapTabKey(event, sidebarRef)
    }

    onMount(() => {
        returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
        if (isModalOverlay) {
            queueMicrotask(() => {
                const firstFocusable = sidebarRef ? getFocusableElements(sidebarRef)[0] : null
                firstFocusable?.focus()
            })
        }
        return () => restoreFocus(returnFocus)
    })

    function closeFromBackdrop(event: MouseEvent) {
        event.stopPropagation()
        onClose?.()
    }

    function slideFromSide(_: HTMLElement, options: { duration?: number }) {
        return {
            duration: options.duration ?? duration,
            css: (t: number) => {
                const eased = cubicOut(t)
                const translateX = side === "left" ? (eased - 1) * 100 : (1 - eased) * 100
                return `transform: translateX(${translateX}%);`
            },
        }
    }
</script>

{#if showBackdrop && presentation === "overlay"}
    <button
        class="sidebar-backdrop"
        type="button"
        aria-label={backdropLabel}
        onclick={closeFromBackdrop}
    ></button>
{/if}

<aside
    bind:this={sidebarRef}
    class={["sidebar", side, presentation]}
    style:--sidebar-width={width}
    transition:slideFromSide={{ duration }}
    onmouseleave={onMouseLeave}
    onkeydowncapture={handleKeydown}
    aria-label={ariaLabel}
    role={isModalOverlay ? "dialog" : undefined}
    aria-modal={isModalOverlay ? "true" : undefined}
>
    {@render header?.()}
    {@render search?.()}
    <div class="sidebar-body">{@render children()}</div>
    {@render footer?.()}
</aside>

<style>
    .sidebar {
        top: 0;
        bottom: 0;
        z-index: var(--z-fixed);
        display: flex;
        flex: 0 0 var(--sidebar-width, clamp(20rem, 38vw, 24rem));
        flex-direction: column;
        width: var(--sidebar-width, clamp(20rem, 38vw, 24rem));
        min-width: 0;
        box-sizing: border-box;
        overflow: visible;
        background: var(--surface-color);
        color: var(--text-color);
        font-family: var(--ui-font);
        --sidebar-safe-area-end: 0px;
    }

    .sidebar.overlay {
        position: absolute;
    }

    .sidebar.docked {
        position: relative;
        z-index: var(--z-10);
        flex-basis: var(--sidebar-width, clamp(20rem, 22vw, 24rem));
        width: var(--sidebar-width, clamp(20rem, 22vw, 24rem));
        box-shadow: none;
    }

    .sidebar.right.docked {
        order: 2;
    }

    .sidebar.left {
        left: 0;
        border-right: var(--border-inline) solid var(--border-color);
    }

    .sidebar.right {
        right: 0;
        border-left: var(--border-inline) solid var(--border-color);
    }

    .sidebar.overlay.left {
        box-shadow: 6px 0 0 var(--shadow-color);
    }

    .sidebar.overlay.right {
        box-shadow: -6px 0 0 var(--shadow-color);
    }

    .sidebar-body {
        display: flex;
        flex: 1;
        min-height: 0;
        flex-direction: column;
        overflow: hidden;
    }

    .sidebar-backdrop {
        position: absolute;
        inset: 0;
        z-index: 190;
        display: block;
        width: 100%;
        height: 100%;
        padding: 0;
        cursor: pointer;
        border: 0;
        background: var(--overlay-color);
        backdrop-filter: none;
        animation: fade-in 0.15s ease-out;
    }

    @keyframes fade-in {
        from {
            opacity: 0;
        }
        to {
            opacity: 1;
        }
    }

    @media (--compact) {
        .sidebar,
        .sidebar.left,
        .sidebar.right {
            position: fixed;
            inset: 0;
            z-index: var(--z-modal-backdrop);
            width: 100%;
            height: 100dvh;
            max-height: 100dvh;
            flex-basis: 100%;
            overflow: hidden;
            border: 0;
            box-shadow: none;
            --sidebar-safe-area-end: env(safe-area-inset-bottom);
        }

        .sidebar-backdrop {
            position: fixed;
            z-index: 290;
        }
    }

    @media (forced-colors: active) {
        .sidebar {
            border-color: CanvasText;
        }

        .sidebar-backdrop {
            background: Canvas;
            opacity: 0.5;
        }
    }

    @media (prefers-reduced-motion: reduce) {
        .sidebar-backdrop {
            animation: none;
        }
    }
</style>
