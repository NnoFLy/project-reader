export type Theme = "light" | "dark" | "system"
export type Layout = "single" | "split" | "scroll"
export type Locale = "en" | "ru"
export type ScrollDirection = "up" | "down"

export type SerializableCommandPayload =
    | null
    | boolean
    | number
    | string
    | readonly SerializableCommandPayload[]
    | { readonly [key: string]: SerializableCommandPayload }

export type CommandId = string

export type ExecuteArgs<_K extends CommandId = CommandId> = [payload?: unknown]
