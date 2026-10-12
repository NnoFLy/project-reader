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

/**
 * @deprecated Commands are registered with string metadata and plugin-local
 * payload validators. This compatibility index intentionally has no
 * application-wide command map and should disappear as built-ins migrate.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AppCommandPayloads = Record<string, any>

export type CommandId = string

export type ExecuteArgs<_K extends CommandId = CommandId> = [payload?: unknown]
