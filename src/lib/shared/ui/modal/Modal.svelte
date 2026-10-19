<script lang="ts">
    import { onMount, tick } from "svelte"
    import CloseIcon from "$lib/shared/icons/CloseIcon.svelte"
    import { viewport } from "$lib/shared/state/viewport.svelte"
    import Button from "../Button.svelte"
    import Float from "./Float.svelte"
    import {
        dismissFocusedInteractiveElement,
        getFocusableElements,
        restoreFocus,
        trapTabKey,
    } from "./modalFocus"
    import {
        canDragModal,
        clampModalPosition,
        exceededDragThreshold,
        getVisualViewportBounds,
        isDragPointerAllowed,
        type ModalPosition,
    } from "./modalDrag"
    import { modalManager } from "./modalManager.svelte"
    import { resolveModalPresentation } from "./modalPresentation"
    import { shouldCloseOnBackdrop } from "./modalPolicy"
    import type { ModalCloseReason, ModalProps } from "./modal.types"
    import * as m from "$lib/paraglide/messages"

    let props: ModalProps = $props()

    const generatedId = $props.id()
    let modalId = $derived(props.id ?? generatedId)
    let titleId = $derived(`${modalId}-title`)
    let descriptionId = $derived(`${modalId}-description`)

    let surfaceRef = $state<HTMLElement | null>(null)
    let scrollRegionRef = $state<HTMLElement | null>(null)
    let confirmationMessageRef = $state<HTMLParagraphElement | null>(null)
    let closeButtonRef = $state<HTMLButtonElement | null>(null)
    let localBusy = $state(false)
    let position = $state<ModalPosition | null>(null)
    let dragStart: {
        pointerX: number
        pointerY: number
        x: number
        y: number
        pointerType: string
    } | null = null

    let variant = $derived(props.variant ?? "default")
    let modalType = $derived(props.type ?? "float")
    let modalSize = $derived(props.size ?? (modalType === "layout" ? "large" : "medium"))
    let modalPlacement = $derived(props.placement ?? "center")
    let showHeader = $derived(props.showHeader ?? true)
    let showCloseButton = $derived(
        props.showCloseButton ?? (variant === "confirmation" ? Boolean(props.cancelLabel) : true),
    )
    let isBusy = $derived(variant === "confirmation" && (Boolean(props.busy) || localBusy))
    let modalState = $derived(modalManager.get(modalId)?.state ?? "blocking")
    let presentation = $derived(
        resolveModalPresentation({
            isCompact: viewport.isCompact,
            mobilePresentation: props.mobilePresentation ?? "auto",
            type: modalType,
            size: modalSize,
            state: modalState,
        }),
    )
    let isDraggable = $derived(
        variant === "default" &&
            canDragModal({
                requested: Boolean(props.draggable),
                showHeader,
                isCompact: viewport.isCompact,
                presentation,
            }),
    )
    let isTopmostBlocking = $derived(modalManager.topmostBlockingModal?.id === modalId)
    let zIndex = $derived(modalManager.zIndex(modalId))
    let surfaceStyle = $derived(
        position && isDraggable
            ? `position:fixed;left:${position.x}px;top:${position.y}px;margin:0;`
            : "",
    )
    let floatPlacementProps = $derived(
        presentation === "sheet"
            ? ({ placement: "bottom" } as const)
            : presentation === "fullscreen"
              ? ({ placement: "center" } as const)
              : modalPlacement === "anchor"
                ? ({ placement: "anchor", anchor: props.anchor! } as const)
                : ({ placement: modalPlacement } as const),
    )

    function requestClose(reason: ModalCloseReason) {
        if (isBusy) return
        if (variant === "confirmation") {
            if (reason === "backdrop") return
            if (reason === "escape" || reason === "close-button" || reason === "cancel") {
                if (!props.cancelLabel) return
                props.onCancel?.()
                props.onClose("cancel")
                return
            }
        }
        props.onClose(reason)
    }

    async function confirm() {
        if (variant !== "confirmation" || isBusy) return
        localBusy = true
        try {
            await props.onConfirm!()
            props.onClose("confirmed")
        } finally {
            localBusy = false
        }
    }

    function resolveInitialFocus(): HTMLElement | null {
        const requested = props.initialFocus
        if (requested instanceof HTMLElement) return requested
        if (typeof requested === "function") return requested()
        if (requested === "close") return closeButtonRef
        if (requested === "first") return surfaceRef ? getFocusableElements(surfaceRef)[0] : null
        if (variant === "confirmation" && surfaceRef) {
            if (
                scrollRegionRef &&
                scrollRegionRef.scrollHeight > scrollRegionRef.clientHeight + 1
            ) {
                return confirmationMessageRef
            }
            return surfaceRef.querySelector<HTMLElement>(".confirmation-actions button:last-child")
        }
        return surfaceRef ? getFocusableElements(surfaceRef)[0] : null
    }

    function captureScrollRegion(node: HTMLElement) {
        scrollRegionRef = node
        return () => {
            if (scrollRegionRef === node) scrollRegionRef = null
        }
    }

    function captureConfirmationMessage(node: HTMLParagraphElement) {
        confirmationMessageRef = node
        return () => {
            if (confirmationMessageRef === node) confirmationMessageRef = null
        }
    }

    function handleWindowKeydown(event: KeyboardEvent) {
        if (!isTopmostBlocking || modalState !== "blocking" || !surfaceRef) return
        if (event.key === "Tab") {
            trapTabKey(event, surfaceRef)
            return
        }
        if (event.key !== "Escape") return

        const canEscape =
            variant === "confirmation"
                ? Boolean(props.cancelLabel) && !isBusy
                : (props.closeOnEscape ?? true)
        if (!canEscape) return
        event.preventDefault()
        event.stopImmediatePropagation()
        if (dismissFocusedInteractiveElement(surfaceRef)) return
        requestClose("escape")
    }

    function handleSurfacePointerDown() {
        if (modalState === "modeless") modalManager.bringToFront(modalId)
    }

    function handleHeaderPointerDown(event: PointerEvent) {
        if (
            !isDraggable ||
            !isDragPointerAllowed(event.pointerType) ||
            event.button !== 0 ||
            !surfaceRef
        )
            return
        const target = event.target as HTMLElement
        if (target.closest("button, a, input, select, textarea, [contenteditable='true']")) return
        const rect = surfaceRef.getBoundingClientRect()
        dragStart = {
            pointerX: event.clientX,
            pointerY: event.clientY,
            x: rect.left,
            y: rect.top,
            pointerType: event.pointerType,
        }
        if (event.currentTarget instanceof HTMLElement) {
            event.currentTarget.setPointerCapture(event.pointerId)
        }
    }

    function handleHeaderPointerMove(event: PointerEvent) {
        if (
            !dragStart ||
            !surfaceRef ||
            !isDraggable ||
            !isDragPointerAllowed(dragStart.pointerType)
        )
            return
        const dx = event.clientX - dragStart.pointerX
        const dy = event.clientY - dragStart.pointerY
        if (modalState === "blocking" && !exceededDragThreshold(dx, dy)) return
        if (modalState === "blocking") modalManager.setModeless(modalId)
        position = clampModalPosition(
            { x: dragStart.x + dx, y: dragStart.y + dy },
            surfaceRef.getBoundingClientRect(),
            getVisualViewportBounds(),
        )
    }

    function handleHeaderPointerUp(event: PointerEvent) {
        if (
            event.currentTarget instanceof HTMLElement &&
            event.currentTarget.hasPointerCapture(event.pointerId)
        ) {
            event.currentTarget.releasePointerCapture(event.pointerId)
        }
        dragStart = null
    }

    function reclampPosition() {
        if (!position || !surfaceRef) return
        position = clampModalPosition(
            position,
            surfaceRef.getBoundingClientRect(),
            getVisualViewportBounds(),
        )
    }

    onMount(() => {
        if (!props.title && !props.ariaLabel) throw new Error("Modal requires title or ariaLabel")
        if (modalPlacement === "anchor" && !props.anchor) {
            throw new Error('Modal placement="anchor" requires an anchor element')
        }
        if (props.draggable && !showHeader) {
            throw new Error("A headerless Modal cannot be draggable")
        }
        if (variant === "confirmation" && (props.draggable || modalSize === "fullscreen")) {
            throw new Error("Confirmation Modals cannot be draggable or fullscreen")
        }

        const restoreFocusTo =
            document.activeElement instanceof HTMLElement ? document.activeElement : null
        const unregister = modalManager.register({
            id: modalId,
            state: "blocking",
            element: surfaceRef,
            close: requestClose,
            restoreFocusTo,
        })

        void tick().then(() => {
            modalManager.updateElement(modalId, surfaceRef)
            requestAnimationFrame(() =>
                (resolveInitialFocus() ?? closeButtonRef ?? surfaceRef)?.focus(),
            )
        })

        const viewport = window.visualViewport
        viewport?.addEventListener("resize", reclampPosition)
        viewport?.addEventListener("scroll", reclampPosition)
        window.addEventListener("resize", reclampPosition)

        return () => {
            viewport?.removeEventListener("resize", reclampPosition)
            viewport?.removeEventListener("scroll", reclampPosition)
            window.removeEventListener("resize", reclampPosition)
            const removed = unregister()
            restoreFocus(removed?.restoreFocusTo ?? null, modalManager.topmostModal?.element)
        }
    })
</script>

<svelte:window onkeydowncapture={handleWindowKeydown} />

<Float
    {...floatPlacementProps}
    backdrop={modalState === "blocking" ? "blur" : "none"}
    onBackdropPointerDown={() => {
        if (shouldCloseOnBackdrop(variant, props.closeOnBackdrop)) requestClose("backdrop")
    }}
    onSurfacePointerDown={handleSurfacePointerDown}
    onSurfaceFocusIn={handleSurfacePointerDown}
    bind:surfaceRef
    wrapperClass={[
        "modal-wrapper",
        `modal-wrapper-${modalType}`,
        `modal-wrapper-${modalSize}`,
        `modal-presentation-${presentation}`,
    ].join(" ")}
    class={[
        "modal-surface",
        `modal-${modalType}`,
        `modal-${modalSize}`,
        `modal-presentation-${presentation}`,
        position && isDraggable && "positioned",
    ]
        .filter(Boolean)
        .join(" ")}
    style={surfaceStyle}
    role={variant === "confirmation" ? "alertdialog" : "dialog"}
    ariaModal={modalState === "blocking"}
    ariaLabel={props.ariaLabel}
    ariaLabelledby={props.title ? titleId : undefined}
    ariaDescribedby={props.description ? descriptionId : undefined}
    {presentation}
    movementCritical={isDraggable}
    {zIndex}
>
    {#if props.description}
        <p id={descriptionId} class="visually-hidden">{props.description}</p>
    {/if}

    {#if showHeader}
        <div
            class={["modal-header", isDraggable && "drag-handle"]}
            role="toolbar"
            tabindex={isDraggable ? 0 : undefined}
            aria-label={isDraggable
                ? props.title
                    ? `${m.move()} ${props.title}`
                    : m.move()
                : props.title
                  ? `${props.title} ${m.dialog_header()}`
                  : m.dialog_header()}
            onpointerdown={handleHeaderPointerDown}
            onpointermove={handleHeaderPointerMove}
            onpointerup={handleHeaderPointerUp}
            onpointercancel={handleHeaderPointerUp}
        >
            {#if props.header}
                {#if props.title}
                    <h2 id={titleId} class="visually-hidden">{props.title}</h2>
                {/if}
                <div class="custom-header">{@render props.header()}</div>
                {#if showCloseButton}
                    <Button
                        bind:ref={closeButtonRef}
                        variant="close"
                        square
                        onclick={() => requestClose("close-button")}
                        aria-label={props.closeLabel ?? "Close"}
                        disabled={isBusy}><CloseIcon /></Button
                    >
                {/if}
            {:else}
                <h2 id={titleId} class="modal-title">{props.title}</h2>
                {#if showCloseButton}
                    <Button
                        bind:ref={closeButtonRef}
                        variant="close"
                        square
                        onclick={() => requestClose("close-button")}
                        aria-label={props.closeLabel ?? "Close"}
                        disabled={isBusy}><CloseIcon /></Button
                    >
                {/if}
            {/if}
        </div>
    {:else if props.title}
        <h2 id={titleId} class="visually-hidden">{props.title}</h2>
    {/if}

    <div
        class={[
            "modal-scroll-region",
            variant === "confirmation" || props.mobileFooter !== "fixed"
                ? "mobile-footer-flow"
                : "mobile-footer-fixed",
        ]}
        {@attach captureScrollRegion}
    >
        {#if variant === "confirmation"}
            <div class="modal-body confirmation-body">
                <p class="confirmation-message" tabindex="-1" {@attach captureConfirmationMessage}>
                    {props.message}
                </p>
            </div>
            <div class="modal-footer modal-actions confirmation-actions">
                {#if props.cancelLabel}
                    <Button
                        class="confirmation-cancel"
                        variant="action"
                        disabled={isBusy}
                        onclick={() => requestClose("cancel")}>{props.cancelLabel}</Button
                    >
                {/if}
                <Button
                    variant="action"
                    class={props.confirmTone === "danger" ? "confirmation-danger" : ""}
                    disabled={isBusy}
                    aria-busy={isBusy}
                    onclick={() => void confirm()}>{props.confirmLabel}</Button
                >
            </div>
        {:else}
            <div class="modal-body">
                {#if modalType === "layout" && props.sidebar}
                    <aside class="modal-sidebar">{@render props.sidebar()}</aside>
                    <div class="modal-content-region">{@render props.children?.()}</div>
                {:else}
                    {@render props.children?.()}
                {/if}
            </div>
            {#if props.footer}
                <div class="modal-footer">{@render props.footer()}</div>
            {/if}
        {/if}
    </div>
</Float>

<style>
    :global(.modal-wrapper) {
        display: flex;
        flex-direction: column;
        align-items: center;
        padding: 40px 20px;
    }

    :global(.modal-wrapper .modal-surface) {
        max-width: 100%;
        max-height: 100%;
        margin: auto;
    }

    :global(.modal-wrapper.placement-top .modal-surface) {
        margin-top: 80px;
        margin-bottom: auto;
    }

    :global(.modal-wrapper.placement-bottom .modal-surface) {
        margin-top: auto;
        margin-bottom: 0;
    }

    :global(.modal-surface) {
        --modal-small: 34rem;
        --modal-medium: 46rem;
        --modal-large: 72rem;
        display: flex;
        flex-direction: column;
        width: min(var(--modal-width), calc(var(--float-viewport-width, 100vw) - 40px));
        max-height: min(52rem, calc(var(--float-viewport-height, 100dvh) - 80px));
        min-width: 0;
        min-height: 0;
        overflow: hidden;
        background: var(--surface-color);
        border: var(--border-elevated) solid var(--border-color);
        border-radius: var(--radius-md);
        box-shadow: var(--shadow-elevated);
        color: var(--text-color);
        font-family: inherit;
    }

    :global(.modal-small) {
        --modal-width: var(--modal-small);
    }
    :global(.modal-medium) {
        --modal-width: var(--modal-medium);
    }
    :global(.modal-large) {
        --modal-width: var(--modal-large);
        height: min(48rem, calc(var(--float-viewport-height, 100dvh) - 80px));
    }
    :global(.modal-fullscreen) {
        --modal-width: calc(var(--float-viewport-width, 100vw) - 40px);
        width: var(--modal-width);
        height: calc(var(--float-viewport-height, 100dvh) - 40px);
        max-height: none;
    }
    :global(.modal-surface.positioned) {
        max-width: calc(var(--float-viewport-width, 100vw) - 16px);
        max-height: calc(var(--float-viewport-height, 100dvh) - 16px);
    }

    .modal-header,
    .modal-footer {
        flex: 0 0 auto;
        background: var(--bg-color);
    }

    .modal-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        min-width: 0;
        min-height: 52px;
        box-sizing: border-box;
        padding: 12px 16px;
        border-bottom: 2px solid var(--border-color);
    }

    .modal-header.drag-handle {
        cursor: grab;
        user-select: none;
        touch-action: none;
    }
    .modal-header.drag-handle:active {
        cursor: grabbing;
    }
    .modal-header.drag-handle:focus-visible {
        outline: 3px solid var(--accent-color);
        outline-offset: -5px;
    }

    .custom-header {
        min-width: 0;
        width: 100%;
    }

    .modal-title {
        min-width: 0;
        margin: 0;
        overflow-wrap: anywhere;
        font-size: var(--font-size-3xl);
        font-weight: 700;
        letter-spacing: -0.01em;
    }

    .modal-scroll-region,
    .modal-body,
    .modal-content-region,
    .modal-sidebar {
        min-width: 0;
        min-height: 0;
    }

    .modal-scroll-region {
        display: flex;
        flex: 1 1 auto;
        flex-direction: column;
    }

    .modal-body {
        display: flex;
        flex: 1 1 auto;
        flex-direction: column;
        overflow-x: hidden;
        overflow-y: auto;
        overscroll-behavior: contain;
        scroll-padding-block: 16px;
    }

    :global(.modal-body > .modal-form) {
        display: flex;
        flex-direction: column;
        gap: 20px;
        width: 100%;
        box-sizing: border-box;
        padding: 20px 24px 24px;
    }

    :global(.modal-layout) .modal-body {
        display: grid;
        grid-template-columns: minmax(12rem, 18rem) minmax(0, 1fr);
        overflow: hidden;
    }
    .modal-sidebar,
    .modal-content-region {
        overflow-x: hidden;
        overflow-y: auto;
        overscroll-behavior: contain;
    }
    .modal-sidebar {
        border-right: 2px solid var(--border-color);
        background: var(--bg-color);
    }

    .modal-footer {
        box-sizing: border-box;
        padding: 12px max(24px, var(--float-safe-area-inset-right, 0px))
            calc(12px + var(--float-safe-area-inset-bottom, 0px))
            max(24px, var(--float-safe-area-inset-left, 0px));
        border-top: 2px solid var(--border-color);
    }

    :global(.modal-footer .modal-actions),
    .modal-footer.modal-actions {
        display: flex;
        justify-content: flex-end;
        align-items: center;
        gap: 12px;
        width: 100%;
    }

    .confirmation-body {
        padding: 20px;
    }
    .confirmation-message {
        margin: 0;
        overflow-wrap: anywhere;
        font-size: var(--font-size-xl);
        line-height: 1.5;
    }
    .confirmation-actions {
        display: flex;
        justify-content: flex-end;
        gap: 12px;
    }
    .confirmation-actions :global(.confirmation-danger:not(:disabled)) {
        background: var(--danger-color);
        color: var(--danger-text-color);
    }

    @media (hover: hover) {
        .confirmation-actions :global(.confirmation-danger:hover:not(:disabled)) {
            background: var(--danger-active-color);
        }
    }

    .visually-hidden {
        position: absolute;
        width: 1px;
        height: 1px;
        padding: 0;
        margin: -1px;
        overflow: hidden;
        clip: rect(0, 0, 0, 0);
        white-space: nowrap;
        border: 0;
    }

    @media (--mobile) {
        :global(.modal-wrapper) {
            padding: 16px 12px;
        }
        :global(.modal-wrapper.placement-top .modal-surface) {
            margin-top: 0;
        }
        :global(.modal-surface) {
            width: min(var(--modal-width), calc(var(--float-viewport-width, 100vw) - 24px));
            max-height: calc(var(--float-viewport-height, 100dvh) - 32px);
        }

        :global(.modal-wrapper.modal-presentation-sheet) {
            justify-content: flex-end;
            padding: var(--float-safe-area-inset-top, 0px) 0 0;
        }
        :global(.modal-wrapper.modal-presentation-sheet .modal-surface) {
            width: var(--float-viewport-width, 100vw);
            max-height: calc(
                var(--float-viewport-height, 100dvh) - var(--float-safe-area-inset-top, 0px)
            );
            margin: auto 0 0;
            border-right: 0;
            border-bottom: 0;
            border-left: 0;
            border-radius: var(--radius-md) var(--radius-md) 0 0;
            box-shadow: none;
        }

        :global(.modal-wrapper.modal-presentation-fullscreen) {
            padding: 0;
        }
        :global(.modal-surface.modal-presentation-fullscreen) {
            width: var(--float-viewport-width, 100vw);
            height: var(--float-viewport-height, 100dvh);
            max-height: none;
            border-right: 0;
            border-left: 0;
            border-radius: 0;
            box-shadow: none;
        }
        :global(.modal-layout) .modal-body {
            grid-template-columns: 1fr;
        }
        .modal-sidebar {
            max-height: 35%;
            border-right: 0;
            border-bottom: 2px solid var(--border-color);
        }
        .modal-header {
            min-height: 44px;
            padding: 4px max(12px, var(--float-safe-area-inset-right, 0px)) 4px
                max(12px, var(--float-safe-area-inset-left, 0px));
        }
        .modal-title {
            font-size: var(--font-size-xl);
            letter-spacing: 0;
        }
        :global(.modal-presentation-fullscreen) .modal-header {
            padding-top: calc(8px + var(--float-safe-area-inset-top, 0px));
        }
        .modal-footer {
            padding: 12px max(16px, var(--float-safe-area-inset-right, 0px))
                calc(12px + var(--float-safe-area-inset-bottom, 0px))
                max(16px, var(--float-safe-area-inset-left, 0px));
        }
        :global(.modal-body > .modal-form) {
            padding: 16px max(16px, var(--float-safe-area-inset-right, 0px)) 16px
                max(16px, var(--float-safe-area-inset-left, 0px));
        }
        .confirmation-body {
            padding-right: max(24px, var(--float-safe-area-inset-right, 0px));
            padding-left: max(24px, var(--float-safe-area-inset-left, 0px));
        }
        :global(.modal-wrapper.modal-presentation-sheet) .modal-scroll-region.mobile-footer-flow {
            flex: 0 1 auto;
            overflow-x: hidden;
            overflow-y: auto;
            overscroll-behavior: contain;
        }
        :global(.modal-wrapper.modal-presentation-sheet)
            .modal-scroll-region.mobile-footer-flow
            .modal-body {
            flex: 0 0 auto;
            overflow-y: visible;
        }
        :global(.modal-footer .modal-actions),
        .modal-footer.modal-actions {
            flex-direction: column;
            align-items: stretch;
        }
        :global(.modal-footer .modal-actions > *),
        :global(.modal-footer.modal-actions > *) {
            width: 100%;
            min-height: 44px;
            white-space: normal;
        }
    }

    @media (max-width: 800px) and (max-height: 500px) {
        .modal-header {
            min-height: 40px;
            padding-top: 2px;
            padding-bottom: 2px;
        }
        .modal-title {
            font-size: var(--font-size-lg);
        }
        .modal-footer {
            padding-top: 8px;
            padding-bottom: calc(8px + var(--float-safe-area-inset-bottom, 0px));
        }
        :global(.modal-footer .modal-actions),
        .modal-footer.modal-actions {
            flex-direction: row;
        }
        :global(.modal-footer .modal-actions > *),
        :global(.modal-footer.modal-actions > *) {
            width: auto;
            flex: 1 1 0;
        }
        :global(.modal-body > .modal-form) {
            gap: 12px;
            padding-top: 12px;
            padding-bottom: 12px;
        }
    }

    @media (prefers-reduced-motion: reduce) {
        :global(.modal-surface),
        .modal-header {
            transition: none;
        }
    }
</style>
