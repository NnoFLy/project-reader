// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest"
import { restoreFocus } from "./modalFocus"

afterEach(() => document.body.replaceChildren())

describe("focus after concurrent editor closes", () => {
    it("preserves focus in B when background editor A finishes saving", () => {
        const opener = document.createElement("button")
        const editorA = document.createElement("div")
        const editorB = document.createElement("input")
        document.body.append(opener, editorA, editorB)
        editorB.focus()

        restoreFocus(opener, editorB, editorA)

        expect(document.activeElement).toBe(editorB)
    })

    it("restores the opener when the closing editor owned focus", () => {
        const opener = document.createElement("button")
        const editor = document.createElement("div")
        const field = document.createElement("input")
        editor.append(field)
        document.body.append(opener, editor)
        field.focus()

        restoreFocus(opener, null, editor)

        expect(document.activeElement).toBe(opener)
    })
})
