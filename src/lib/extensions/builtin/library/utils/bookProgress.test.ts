import { describe, expect, it } from "vitest"
import { formatBookProgress } from "./bookProgress"

const ofPages = (total: number) => `Of ${total}`

describe("formatBookProgress", () => {
    it("includes a valid current page before the localized total", () => {
        expect(formatBookProgress(3, 10, ofPages)).toBe("3 Of 10")
    })

    it.each([undefined, 0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 11])(
        "keeps total-only output for invalid page %s",
        (page) => {
            expect(formatBookProgress(page, 10, ofPages)).toBe("Of 10")
        },
    )

    it.each([undefined, 0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
        "omits invalid total %s",
        (total) => {
            expect(formatBookProgress(1, total, ofPages)).toBeUndefined()
        },
    )
})
