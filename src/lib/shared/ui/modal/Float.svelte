<script lang="ts">
    import { motionPreferences } from "$lib/shared/state/motion.svelte"
    import { cubicOut } from "svelte/easing"
    import { onMount, type Snippet } from "svelte"
    import { fade } from "svelte/transition"
    import { shouldEnableModalPresentationMotion } from "./modalMotion"

    export type FloatPlacement = "center" | "top" | "bottom" | "anchor"
    export type FloatPresentation = "dialog" | "sheet" | "fullscreen"

    function presentationTransition(
        _node: HTMLElement,
        { presentation, enabled }: { presentation: FloatPresentation; enabled: boolean },
    ) {
        if (!enabled) return { duration: 0 }
        const duration = presentation === "dialog" ? 180 : 160
        return {
            duration,
            easing: cubicOut,
            css: (t: number) => {
                const transform =
                    presentation === "dialog"
                        ? `scale(${0.96 + 0.04 * t})`
                        : presentation === "sheet"
                          ? `translateY(${20 * (1 - t)}px)`
                          : `translateY(${8 * (1 - t)}px)`
                return `opacity:${t};transform:${transform}`
            },
        }
    }

    type Props = {
        children: Snippet
        backdrop?: "none" | "transparent" | "blur"
        onBackdropPointerDown?: (event: PointerEvent) => void
        onSurfacePointerDown?: (event: PointerEvent) => void
        onSurfaceFocusIn?: (event: FocusEvent) => void
        surfaceRef?: HTMLElement | null
        wrapperClass?: string
        class?: string
        style?: string
        role?: string
        ariaModal?: boolean
        ariaLabel?: string
        ariaLabelledby?: string
        ariaDescribedby?: string
        presentation?: FloatPresentation
        movementCritical?: boolean
        zIndex?: number
    } & (
        | { placement: "anchor"; anchor: HTMLElement }
        | { placement?: Exclude<FloatPlacement, "anchor">; anchor?: never }
    )

    let {
        children,
        placement = "center",
        anchor,
        backdrop = "blur",
        onBackdropPointerDown,
        onSurfacePointerDown,
        onSurfaceFocusIn,
        surfaceRef = $bindable(null),
        wrapperClass = "",
        class: className = "",
        style = "",
        role,
        ariaModal,
        ariaLabel,
        ariaLabelledby,
        ariaDescribedby,
        presentation = "dialog",
        movementCritical = false,
        zIndex = 1000,
    }: Props = $props()

    let viewportHeight = $state("100dvh")
    let viewportWidth = $state("100vw")
    let viewportTop = $state("0px")
    let viewportLeft = $state("0px")
    let safeAreaInsetTop = $state("env(safe-area-inset-top, 0px)")
    let safeAreaInsetRight = $state("env(safe-area-inset-right, 0px)")
    let safeAreaInsetBottom = $state("env(safe-area-inset-bottom, 0px)")
    let safeAreaInsetLeft = $state("env(safe-area-inset-left, 0px)")
    let anchorPosition = $state({ x: 0, y: 0 })

    function updateAnchorPosition() {
        if (placement !== "anchor" || !anchor || !surfaceRef) return
        const anchorRect = anchor.getBoundingClientRect()
        const surfaceRect = surfaceRef.getBoundingClientRect()
        const viewport = window.visualViewport
        const left = viewport?.offsetLeft ?? 0
        const top = viewport?.offsetTop ?? 0
        const right = left + (viewport?.width ?? window.innerWidth)
        const bottom = top + (viewport?.height ?? window.innerHeight)
        anchorPosition = {
            x: Math.min(Math.max(anchorRect.left, left + 8), right - surfaceRect.width - 8),
            y: Math.min(Math.max(anchorRect.bottom + 8, top + 8), bottom - surfaceRect.height - 8),
        }
    }

    onMount(() => {
        const visualViewport = window.visualViewport
        const updateViewport = () => {
            const height = visualViewport?.height ?? window.innerHeight
            const top = visualViewport?.offsetTop ?? 0
            const isKeyboardOpen = window.innerHeight - height > 80

            viewportHeight = `${height}px`
            viewportWidth = `${visualViewport?.width ?? window.innerWidth}px`
            viewportTop = `${top}px`
            viewportLeft = `${visualViewport?.offsetLeft ?? 0}px`
            safeAreaInsetTop = "env(safe-area-inset-top, 0px)"
            safeAreaInsetRight = "env(safe-area-inset-right, 0px)"
            safeAreaInsetBottom = isKeyboardOpen ? "0px" : "env(safe-area-inset-bottom, 0px)"
            safeAreaInsetLeft = "env(safe-area-inset-left, 0px)"
            updateAnchorPosition()
        }
        visualViewport?.addEventListener("resize", updateViewport)
        visualViewport?.addEventListener("scroll", updateViewport)
        window.addEventListener("resize", updateViewport)
        window.addEventListener("scroll", updateViewport, true)
        requestAnimationFrame(updateViewport)
        return () => {
            visualViewport?.removeEventListener("resize", updateViewport)
            visualViewport?.removeEventListener("scroll", updateViewport)
            window.removeEventListener("resize", updateViewport)
            window.removeEventListener("scroll", updateViewport, true)
        }
    })

    function captureSurface(node: HTMLElement) {
        surfaceRef = node
        return () => {
            if (surfaceRef === node) surfaceRef = null
        }
    }

    function portal(node: HTMLElement) {
        let host = document.getElementById("modal-overlay-host")
        if (!host) {
            host = document.createElement("div")
            host.id = "modal-overlay-host"
            document.body.appendChild(host)
        }
        host.appendChild(node)
        return () => {
            node.remove()
            if (host?.childElementCount === 0) host.remove()
        }
    }

    let surfaceStyle = $derived(
        [
            style,
            placement === "anchor"
                ? `position:fixed;left:${anchorPosition.x}px;top:${anchorPosition.y}px;margin:0;`
                : "",
        ]
            .filter(Boolean)
            .join(";"),
    )
</script>

<div
    {@attach portal}
    class={[
        "float-wrapper",
        `placement-${placement}`,
        backdrop === "none" && "without-backdrop",
        wrapperClass,
    ]}
    style:height={viewportHeight}
    style:width={viewportWidth}
    style:top={viewportTop}
    style:left={viewportLeft}
    style:z-index={zIndex}
    style:--float-viewport-height={viewportHeight}
    style:--float-viewport-width={viewportWidth}
    style:--float-safe-area-inset-top={safeAreaInsetTop}
    style:--float-safe-area-inset-right={safeAreaInsetRight}
    style:--float-safe-area-inset-bottom={safeAreaInsetBottom}
    style:--float-safe-area-inset-left={safeAreaInsetLeft}
    data-presentation={presentation}
>
    {#if backdrop !== "none"}
        <div
            class={["float-backdrop", `backdrop-${backdrop}`]}
            transition:fade|global={{ duration: motionPreferences.enabled ? 150 : 0 }}
            onpointerdown={onBackdropPointerDown}
            aria-hidden="true"
        ></div>
    {/if}
    <div
        {@attach captureSurface}
        class={["float-surface", className]}
        style={surfaceStyle}
        {role}
        aria-modal={ariaModal}
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledby}
        aria-describedby={ariaDescribedby}
        tabindex="-1"
        onpointerdown={onSurfacePointerDown}
        onfocusin={onSurfaceFocusIn}
        data-presentation={presentation}
        data-modal-movement={movementCritical ? "true" : undefined}
        transition:presentationTransition|global={{
            presentation,
            enabled: shouldEnableModalPresentationMotion({
                appMotionEnabled: motionPreferences.enabled,
                movementCritical,
            }),
        }}
    >
        {@render children()}
    </div>
</div>

<style>
    .float-wrapper {
        position: fixed;
        isolation: isolate;
        box-sizing: border-box;
        pointer-events: none;
    }

    .float-backdrop {
        position: absolute;
        z-index: 0;
        inset: 0;
        background: rgb(0 0 0 / 0.4);
        pointer-events: auto;
    }

    .backdrop-blur {
        backdrop-filter: blur(8px);
        -webkit-backdrop-filter: blur(8px);
    }

    .backdrop-transparent {
        background: transparent;
    }

    .float-surface {
        position: relative;
        z-index: 1;
        min-width: 0;
        min-height: 0;
        box-sizing: border-box;
        pointer-events: auto;
        overscroll-behavior: contain;
    }
</style>
