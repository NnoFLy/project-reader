<script lang="ts">
    import type { Snippet } from "svelte"
    import { cubicOut } from "svelte/easing"
    import { motionPreferences } from "$lib/shared/state/motion.svelte"
    import ChevronIcon from "$lib/shared/icons/ChevronIcon.svelte"
    import { createFloatingState } from "$lib/shared/state/floating.svelte"

    interface Props {
        trigger: Snippet
        children: Snippet<[{ close: () => void }]>
        label?: string
        align?: "left" | "right"
        class?: string
    }

    let { trigger, children, label, align = "right", class: className = "" }: Props = $props()

    let isOpen = $state(false)
    let containerEl = $state<HTMLElement | null>(null)

    const floating = createFloatingState({
        defaultHorizontal: () => align,
        defaultVertical: "bottom",
    })
    const attachFloating = (
        floating as typeof floating & {
            attach: (node: HTMLElement) => void | (() => void)
        }
    ).attach

    function trackContainer(node: HTMLElement) {
        containerEl = node
        return () => {
            if (containerEl === node) containerEl = null
        }
    }

    function toggleDropdown() {
        isOpen = !isOpen
        if (isOpen) floating.update()
    }

    function close() {
        isOpen = false
    }

    function readSafeAreaInsets() {
        const probe = document.createElement("div")
        probe.style.cssText = `
            position: fixed;
            visibility: hidden;
            pointer-events: none;
            padding-top: env(safe-area-inset-top);
            padding-right: env(safe-area-inset-right);
            padding-bottom: env(safe-area-inset-bottom);
            padding-left: env(safe-area-inset-left);
        `
        document.body.appendChild(probe)
        const styles = getComputedStyle(probe)
        const insets = {
            top: Number.parseFloat(styles.paddingTop) || 0,
            right: Number.parseFloat(styles.paddingRight) || 0,
            bottom: Number.parseFloat(styles.paddingBottom) || 0,
            left: Number.parseFloat(styles.paddingLeft) || 0,
        }
        probe.remove()
        return insets
    }

    function keepInSafeViewport(node: HTMLElement) {
        const viewport = window.visualViewport
        const resizeObserver = new ResizeObserver(updatePosition)

        function updatePosition() {
            const offsetParent = node.offsetParent as HTMLElement | null
            if (!offsetParent) return

            node.style.removeProperty("--viewport-shift-x")
            node.style.removeProperty("--viewport-shift-y")

            const safeArea = readSafeAreaInsets()
            const viewportLeft = (viewport?.offsetLeft ?? 0) + safeArea.left + 8
            const viewportTop = (viewport?.offsetTop ?? 0) + safeArea.top + 8
            const viewportRight =
                (viewport?.offsetLeft ?? 0) +
                (viewport?.width ?? window.innerWidth) -
                safeArea.right -
                8
            const viewportBottom =
                (viewport?.offsetTop ?? 0) +
                (viewport?.height ?? window.innerHeight) -
                safeArea.bottom -
                8

            const parentRect = offsetParent.getBoundingClientRect()
            const opensAbove = node.classList.contains("pos-top")
            const spaceAbove = Math.max(0, parentRect.top - viewportTop - 8)
            const spaceBelow = Math.max(0, viewportBottom - parentRect.bottom - 8)
            const preferredSpace = opensAbove ? spaceAbove : spaceBelow
            const alternateSpace = opensAbove ? spaceBelow : spaceAbove

            if (preferredSpace < node.scrollHeight && alternateSpace > preferredSpace) {
                floating.setVertical(opensAbove ? "bottom" : "top")
                requestAnimationFrame(updatePosition)
                return
            }

            node.style.maxHeight = `${preferredSpace}px`

            const naturalLeft = parentRect.left + node.offsetLeft
            const naturalTop = parentRect.top + node.offsetTop
            const naturalRight = naturalLeft + node.offsetWidth
            const naturalBottom = naturalTop + node.offsetHeight

            const shiftX = Math.max(
                viewportLeft - naturalLeft,
                Math.min(0, viewportRight - naturalRight),
            )
            const shiftY = Math.max(
                viewportTop - naturalTop,
                Math.min(0, viewportBottom - naturalBottom),
            )

            node.style.setProperty("--viewport-shift-x", `${shiftX}px`)
            node.style.setProperty("--viewport-shift-y", `${shiftY}px`)
        }

        updatePosition()
        resizeObserver.observe(node)
        window.addEventListener("resize", updatePosition)
        viewport?.addEventListener("resize", updatePosition)
        viewport?.addEventListener("scroll", updatePosition)

        return () => {
            resizeObserver.disconnect()
            window.removeEventListener("resize", updatePosition)
            viewport?.removeEventListener("resize", updatePosition)
            viewport?.removeEventListener("scroll", updatePosition)
        }
    }

    function handleClickOutside(event: MouseEvent) {
        if (isOpen && containerEl && !containerEl.contains(event.target as Node)) {
            isOpen = false
        }
    }

    function expandFromTrigger(node: HTMLElement, { duration = 180 } = {}) {
        if (!motionPreferences.enabled) {
            return { duration: 0 }
        }

        const triggerEl = node.parentElement?.querySelector(".switcher-trigger") as HTMLElement
        if (!triggerEl) return {}

        const triggerRect = triggerEl.getBoundingClientRect()
        const dropdownRect = node.getBoundingClientRect()
        const parentRect = node.parentElement!.getBoundingClientRect()

        const triggerLeft = triggerRect.left - parentRect.left
        const triggerTop = triggerRect.top - parentRect.top
        const dropdownLeft = dropdownRect.left - parentRect.left
        const dropdownTop = dropdownRect.top - parentRect.top

        const w1 = triggerRect.width
        const h1 = triggerRect.height
        const w2 = dropdownRect.width
        const h2 = dropdownRect.height

        const sx = w1 / w2
        const sy = h1 / h2

        const cx1 = triggerLeft + w1 / 2
        const cy1 = triggerTop + h1 / 2
        const cx2 = dropdownLeft + w2 / 2
        const cy2 = dropdownTop + h2 / 2

        const dx = cx1 - cx2
        const dy = cy1 - cy2

        const isAlignCenter = node.classList.contains("align-center")
        const baseTransform = isAlignCenter ? "translateX(-50%)" : ""

        return {
            duration,
            easing: cubicOut,
            css: (t: number, u: number) => {
                const currentSx = sx + (1 - sx) * t
                const currentSy = sy + (1 - sy) * t
                const currentDx = dx * u
                const currentDy = dy * u
                return `
                    transform-origin: center;
                    transform: ${baseTransform} translate(${currentDx}px, ${currentDy}px) scale(${currentSx}, ${currentSy});
                    opacity: ${t};
                `
            },
        }
    }
</script>

<svelte:document onclick={handleClickOutside} />

<div class={`switcher-wrapper ${className}`} {@attach trackContainer} {@attach attachFloating}>
    <button
        class="switcher-trigger"
        class:open={isOpen}
        onclick={toggleDropdown}
        onkeydown={(e) => {
            if (e.key === "Escape" && isOpen) {
                isOpen = false
            }
        }}
        aria-expanded={isOpen}
        aria-haspopup="true"
        aria-label={label}
    >
        {@render trigger()}
        <ChevronIcon class="chevron {isOpen ? 'open' : ''}" />
    </button>

    {#if isOpen}
        <!-- svelte-ignore a11y_no_noninteractive_element_interactions (Escape is delegated from the focused native buttons inside this list) -->
        <ul
            {@attach keepInSafeViewport}
            transition:expandFromTrigger
            class="switcher-dropdown"
            class:pos-top={floating.vertical === "top"}
            class:pos-bottom={floating.vertical === "bottom"}
            class:align-left={floating.horizontal === "left"}
            class:align-center={floating.horizontal === "center"}
            class:align-right={floating.horizontal === "right"}
            onkeydown={(e) => {
                if (e.key === "Escape") {
                    isOpen = false
                    containerEl?.querySelector("button")?.focus()
                }
            }}
        >
            {@render children({ close })}
        </ul>
    {/if}
</div>

<style>
    .switcher-wrapper {
        position: relative;
        display: inline-block;
        font-family: inherit;
    }

    .switcher-trigger {
        display: flex;
        align-items: center;
        min-block-size: var(--control-height-compact);
        box-sizing: border-box;
        gap: var(--control-gap);
        border: var(--border-inline) solid var(--border-color);
        background: var(--surface-color);
        color: var(--text-color);
        padding: 6px var(--control-padding-inline);
        box-shadow: var(--shadow-inline);
        font-family: var(--ui-font);
        font-size: var(--font-size-base);
        font-weight: 700;
        cursor: pointer;
        transition:
            background-color var(--motion-duration-fast) ease,
            border-color var(--motion-duration-fast) ease,
            box-shadow var(--motion-duration-fast) ease;
    }

    @media (hover: hover) {
        .switcher-trigger:hover:not(:active):not(.open) {
            background: var(--surface-hover-color);
        }
    }

    .switcher-trigger:focus-visible {
        outline: none;
        box-shadow: var(--focus-ring);
    }

    .switcher-trigger:active,
    .switcher-trigger.open {
        border-color: var(--accent-active-color);
        background: var(--selected-surface);
        box-shadow: inset 3px 0 0 var(--accent-active-color);
    }

    :global(.chevron) {
        transition: transform 0.2s ease;
    }

    :global(.chevron.open) {
        transform: rotate(180deg);
    }

    .switcher-dropdown {
        position: absolute;
        z-index: var(--z-modal);
        list-style: none;
        margin: 0;
        padding: 0;
        border: var(--border-elevated) solid var(--border-color);
        background: var(--surface-color);
        box-shadow: var(--shadow-elevated);
        min-width: 140px;
        box-sizing: border-box;
        max-width: calc(100dvw - env(safe-area-inset-left) - env(safe-area-inset-right) - 16px);
        max-height: calc(100dvh - env(safe-area-inset-top) - env(safe-area-inset-bottom) - 16px);
        overflow-y: auto;
        overscroll-behavior: contain;
        translate: var(--viewport-shift-x, 0) var(--viewport-shift-y, 0);
        display: flex;
        flex-direction: column;
        gap: 2px;
    }

    .pos-bottom {
        top: calc(100% + 8px);
        bottom: auto;
    }

    .pos-top {
        bottom: calc(100% + 8px);
        top: auto;
    }

    .align-right {
        right: 0;
        left: auto;
    }

    .align-left {
        left: 0;
        right: auto;
    }

    .align-center {
        left: 50%;
        transform: translateX(-50%);
        right: auto;
    }

    :global(.switcher-dropdown li) {
        display: block;
    }

    :global(.dropdown-item) {
        inline-size: 100%;
        display: flex;
        align-items: center;
        gap: 10px;
        background: none;
        border: none;
        color: var(--text-color);
        padding: 8px 12px;
        font-family: var(--ui-font);
        font-size: var(--font-size-base);
        font-weight: 700;
        text-align: start;
        text-decoration: none;
        box-sizing: border-box;
        cursor: pointer;
        transition:
            background-color 0.1s ease,
            color 0.1s ease,
            box-shadow 0.1s ease;
    }

    @media (hover: hover) {
        :global(.dropdown-item:hover),
        :global(.dropdown-item:focus-visible) {
            background: var(--surface-hover-color);
            outline: none;
        }
    }

    :global(.dropdown-item:focus-visible) {
        outline: none;
        box-shadow: inset 0 0 0 2px var(--accent-color);
    }

    :global(.dropdown-item.active) {
        background: var(--selected-surface);
        color: var(--text-color);
        box-shadow: inset 3px 0 0 var(--accent-active-color);
    }

    @media (forced-colors: active) {
        .switcher-trigger:focus-visible,
        :global(.dropdown-item:focus-visible) {
            outline: 2px solid Highlight;
            outline-offset: -2px;
        }
    }

    @media (--tiny-mobile) {
        :global(.switcher-trigger .current-label) {
            display: none;
        }

        .switcher-trigger {
            min-block-size: var(--control-height-regular);
            padding: 6px 8px;
        }

        :global(.dropdown-item) {
            min-block-size: var(--control-height-regular);
        }
    }
</style>
