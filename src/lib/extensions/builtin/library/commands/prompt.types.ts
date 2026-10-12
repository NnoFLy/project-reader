import type { Component } from "svelte"

export interface PromptItemPresentation {
    kind?: string
    // Renderers own their application-specific prop contracts.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    leading?: Component<any>
    leadingProps?: Record<string, unknown>
}

export interface PromptItem<T> {
    id: string
    label: string
    englishLabel?: string
    description?: string
    englishDescription?: string
    category?: string
    keymap?: string | string[]
    value: T
    presentation?: PromptItemPresentation
}

export type PromptItems<T> = (query: string) => PromptItem<T>[] | Promise<PromptItem<T>[]>

export type PromptSelectionBehavior = "close" | "keep-open"

export interface PromptSelectionControls {
    close(): void
    setQuery(query: string): void
}

export interface PromptRequest<T> {
    id: string
    placeholder?: string
    initialQuery?: string
    items: PromptItems<T>
    filter?: "fuzzy" | "none"
    closeOnSelect?: boolean
    rememberQuery?: boolean
    restoreQuery?: boolean
    initialSelection?: (items: PromptItem<T>[]) => number
    onQueryChange?: (query: string) => void
    parseQuery?: (query: string) => T | undefined
    onSelect?: (
        value: T,
        controls: PromptSelectionControls,
    ) => PromptSelectionBehavior | void | Promise<PromptSelectionBehavior | void>
    loadingLabel?: string
    emptyLabel?: string
    errorLabel?: string
    onItemsError?: (error: unknown) => void
    isLoading?: () => boolean
}

export interface PromptSnapshot<T = unknown> {
    request: PromptRequest<T>
    query: string
    items: PromptItem<T>[]
    selectedIndex: number
    isLoading: boolean
    errorLabel?: string
}

export interface PromptService {
    open<T>(request: PromptRequest<T>): Promise<void>
    choose<T>(request: PromptRequest<T>): Promise<T | undefined>
    close(): void
    setQuery(query: string): void
    refresh(): void
    readonly snapshot: PromptSnapshot | null
    readonly isOpen: boolean
    query: string
}
