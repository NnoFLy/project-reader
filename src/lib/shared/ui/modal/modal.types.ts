import type { Snippet } from "svelte"

export type ModalVariant = "default" | "confirmation"
export type ModalType = "float" | "layout"
export type ModalSize = "small" | "medium" | "large" | "fullscreen"
export type ModalPlacement = "center" | "top" | "bottom" | "anchor"
export type MobilePresentation = "auto" | "dialog" | "sheet" | "fullscreen"
export type ModalPresentation = Exclude<MobilePresentation, "auto">
export type ModalState = "blocking" | "modeless"
export type ModalCloseReason =
    | "close-button"
    | "backdrop"
    | "escape"
    | "cancel"
    | "confirmed"
    | "programmatic"

export type ModalInitialFocus = "close" | "first" | HTMLElement | (() => HTMLElement | null)

type AccessibleName =
    | { title: string; ariaLabel?: string }
    | { title?: undefined; ariaLabel: string }

type ModalPlacementProps =
    | { placement: "anchor"; anchor: HTMLElement }
    | { placement?: Exclude<ModalPlacement, "anchor">; anchor?: never }

type CommonModalProps = AccessibleName &
    ModalPlacementProps & {
        id?: string
        description?: string
        closeLabel?: string
        type?: ModalType
        size?: ModalSize
        showHeader?: boolean
        showCloseButton?: boolean
        mobilePresentation?: MobilePresentation
        mobileFooter?: "flow" | "fixed"
        header?: Snippet
        children?: Snippet
        sidebar?: Snippet
        footer?: Snippet
        initialFocus?: ModalInitialFocus
        onActivate?: () => void
        onDeactivate?: () => void
        onClose: (reason: ModalCloseReason) => void
    }

type DragPolicy =
    | { draggable: true; showHeader?: true }
    | { draggable?: false; showHeader?: boolean }

export type DefaultModalProps = CommonModalProps &
    DragPolicy & {
        variant?: "default"
        closeOnBackdrop?: boolean
        closeOnEscape?: boolean
        message?: never
        confirmLabel?: never
        cancelLabel?: never
        confirmTone?: never
        busy?: never
        onConfirm?: never
        onCancel?: never
    }

export type ConfirmationModalProps = Omit<
    CommonModalProps,
    "header" | "sidebar" | "footer" | "type" | "size" | "placement" | "anchor" | "showHeader"
> & {
    variant: "confirmation"
    type?: "float"
    size?: "small" | "medium"
    placement?: "center"
    message: string
    confirmLabel: string
    cancelLabel?: string
    confirmTone?: "default" | "danger"
    busy?: boolean
    onConfirm: () => void | Promise<void>
    onCancel?: () => void
    draggable?: never
    closeOnBackdrop?: never
    closeOnEscape?: never
    showHeader?: true
    mobilePresentation?: Exclude<MobilePresentation, "fullscreen">
    anchor?: never
    header?: never
    sidebar?: never
    footer?: never
}

export type ModalProps = DefaultModalProps | ConfirmationModalProps
