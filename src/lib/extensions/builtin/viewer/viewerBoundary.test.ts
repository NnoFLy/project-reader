import { describe, expect, it } from "vitest"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"

function sourceFiles(directory: string): string[] {
    return readdirSync(directory).flatMap((entry) => {
        const path = join(directory, entry)
        if (statSync(path).isDirectory()) return sourceFiles(path)
        return /\.(ts|svelte)$/.test(path) && !path.includes(".test.") ? [path] : []
    })
}

describe("built-in viewer boundary", () => {
    it("does not import PDF.js or legacy viewer/PDF implementations", () => {
        const forbiddenImport =
            /(?:from|import\s*\()\s*["'](?:pdfjs-dist|\$lib\/modules\/(?:pdf|viewer))/
        const offenders = sourceFiles(
            join(process.cwd(), "src/lib/extensions/builtin/viewer"),
        ).filter((path) => forbiddenImport.test(readFileSync(path, "utf8")))

        expect(offenders).toEqual([])
    })
})
