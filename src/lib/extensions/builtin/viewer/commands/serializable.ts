export type SerializablePayload =
    | null
    | boolean
    | number
    | string
    | readonly SerializablePayload[]
    | { readonly [key: string]: SerializablePayload }

export function isSerializablePayload(value: unknown): value is SerializablePayload {
    return check(value, new Set<object>())
}

function check(value: unknown, stack: Set<object>): value is SerializablePayload {
    if (value === null) return true
    switch (typeof value) {
        case "string":
        case "boolean":
            return true
        case "number":
            return Number.isFinite(value)
        case "object":
            if (stack.has(value)) return false
            stack.add(value)
            try {
                if (Array.isArray(value)) return value.every((item) => check(item, stack))
                if (Object.getPrototypeOf(value) !== Object.prototype) return false
                return Object.values(value).every((item) => check(item, stack))
            } finally {
                stack.delete(value)
            }
        default:
            return false
    }
}
