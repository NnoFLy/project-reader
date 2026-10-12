import { describe, expect, it } from "vitest"
import { isSerializablePayload, serializablePayload } from "./serializable"

describe("serializable command payloads", () => {
    it("accepts JSON-shaped payloads and rejects runtime values", () => {
        expect(isSerializablePayload({ page: 2, options: ["fit", null] })).toBe(true)
        expect(isSerializablePayload({ value: Number.NaN })).toBe(false)
        expect(isSerializablePayload(new Date())).toBe(false)
        expect(isSerializablePayload(() => undefined)).toBe(false)
    })

    it("rejects cyclic objects while allowing repeated values", () => {
        const shared = { value: "ok" }
        expect(isSerializablePayload({ first: shared, second: shared })).toBe(true)

        const cyclic: Record<string, unknown> = {}
        cyclic.self = cyclic
        expect(isSerializablePayload(cyclic)).toBe(false)
    })

    it("composes plugin-local validation with the serializable contract", () => {
        const validate = serializablePayload(
            (payload) =>
                payload !== undefined &&
                typeof payload === "object" &&
                payload !== null &&
                "page" in payload,
        )
        expect(validate({ page: 1 })).toBe(true)
        expect(validate({ query: "text" })).toBe(false)
        expect(validate({ page: () => 1 })).toBe(false)
    })
})
