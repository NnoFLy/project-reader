import type { SerializableCommandPayload } from "./appCommandPayloads"

/**
 * Returns true for values safe to pass through a future extension boundary.
 * Functions, DOM objects, files, symbols, and cyclic objects are rejected.
 */
export function isSerializablePayload(value: unknown): value is SerializableCommandPayload {
    return isSerializable(value, new Set<object>())
}

function isSerializable(value: unknown, stack: Set<object>): value is SerializableCommandPayload {
    if (value === null) return true
    switch (typeof value) {
        case "string":
        case "boolean":
            return true
        case "number":
            return Number.isFinite(value)
        case "object": {
            if (stack.has(value)) return false
            stack.add(value)
            try {
                if (Array.isArray(value)) {
                    return value.every((entry) => isSerializable(entry, stack))
                }
                if (Object.getPrototypeOf(value) !== Object.prototype) return false
                const record = value as Record<string, unknown>
                return Object.keys(record).every((key) => isSerializable(record[key], stack))
            } finally {
                stack.delete(value)
            }
        }
        default:
            return false
    }
}

/** Build a validator that first enforces the serializable payload contract. */
export function serializablePayload(
    validate: (payload: SerializableCommandPayload | undefined) => boolean = () => true,
): (payload: unknown) => boolean {
    return (payload) =>
        (payload === undefined || isSerializablePayload(payload)) &&
        validate(payload as SerializableCommandPayload | undefined)
}
