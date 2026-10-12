import { afterEach, describe, expect, it } from "vitest"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { analyzeProject } from "./check-module-boundaries.mjs"

const checker = fileURLToPath(new URL("./check-module-boundaries.mjs", import.meta.url))
const fixtures: string[] = []

function fixture(files: Record<string, string>, modules: string[] = []): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "module-boundaries-"))
    fixtures.push(root)
    for (const moduleName of modules) {
        files[`src/lib/modules/${moduleName}/index.ts`] ??= "export {}\n"
    }
    for (const [relative, contents] of Object.entries(files)) {
        const target = path.join(root, relative)
        fs.mkdirSync(path.dirname(target), { recursive: true })
        fs.writeFileSync(target, contents)
    }
    return root
}

function cli(root: string) {
    return spawnSync(process.execPath, [checker], { cwd: root, encoding: "utf8" })
}

afterEach(() => {
    for (const root of fixtures.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe("module boundary checker fixtures", () => {
    it("accepts module-root imports and same-module relative imports", () => {
        const root = fixture(
            {
                "src/lib/modules/library/feature.ts":
                    'import "./local"\nimport "$lib/modules/documents"\n',
                "src/lib/modules/library/local.ts": "export {}\n",
            },
            ["library", "documents"],
        )
        const result = cli(root)
        expect(result.status, result.stderr).toBe(0)
        expect(result.stdout).toContain("Module boundaries valid")
    })

    it.each([
        [
            "deep import",
            "src/lib/app/main.ts",
            'import "$lib/modules/library/internal"',
            "deep-imports",
        ],
        [
            "Svelte deep import",
            "src/lib/app/App.svelte",
            '<script>import "$lib/modules/library/internal"</script>',
            "deep-imports",
        ],
        [
            "cross-module relative escape",
            "src/lib/modules/library/main.ts",
            'import "../documents/internal"',
            "cross-module imports must use $lib/modules/documents",
        ],
        [
            "shared to module",
            "src/lib/shared/main.ts",
            'import "$lib/modules/library"',
            "shared code may not import",
        ],
        [
            "shared to app",
            "src/lib/shared/main.ts",
            'import "$lib/app/main"',
            "shared code may not import",
        ],
        [
            "module to route",
            "src/lib/modules/library/main.ts",
            'import "../../../routes/+page"',
            "modules may not import",
        ],
        [
            "generated back-import",
            "src/lib/paraglide/messages.js",
            'import "$lib/shared/state/x"',
            "generated Paraglide",
        ],
        ["old core alias", "src/lib/legacy/main.ts", 'import "$lib/core/state"', "removed alias"],
        [
            "old features alias",
            "src/lib/legacy/main.ts",
            'import "$lib/features/library"',
            "removed alias",
        ],
    ])("rejects %s with a useful diagnostic", (_name, file, source, diagnostic) => {
        const root = fixture({ [file]: source }, ["library", "documents"])
        const result = cli(root)
        expect(result.status).toBe(1)
        expect(result.stderr).toContain(file)
        expect(result.stderr).toContain(diagnostic)
    })

    it("rejects disallowed dependencies", () => {
        const root = fixture(
            { "src/lib/modules/notifications/main.ts": 'import "$lib/modules/documents"' },
            ["notifications", "documents"],
        )
        const result = cli(root)
        expect(result.status).toBe(1)
        expect(result.stderr).toContain("notifications may not depend on documents")
    })

    it("detects dependency cycles", () => {
        const root = fixture(
            {
                "src/lib/modules/library/main.ts": 'import "$lib/modules/documents"',
                "src/lib/modules/documents/main.ts": 'import "$lib/modules/library"',
            },
            ["library", "documents"],
        )
        const result = analyzeProject(root, { library: ["documents"], documents: ["library"] })
        expect(result.violations).toContain(
            "module dependency cycle: documents -> library -> documents",
        )
    })

    it("rejects modules without an index", () => {
        const root = fixture({ "src/lib/modules/library/main.ts": "export {}" })
        const result = cli(root)
        expect(result.status).toBe(1)
        expect(result.stderr).toContain("src/lib/modules/library: module is missing index.ts")
    })

    it("ignores import-like text in comments, strings, templates, and Svelte markup", () => {
        const root = fixture({
            "src/lib/app/main.ts": [
                '// import "$lib/features/legacy"',
                "const example = 'import \"$lib/modules/viewer/internal\"'",
                'const template = `import "$lib/modules/library/internal"`',
                "void example",
                "void template",
            ].join("\n"),
            "src/lib/app/App.svelte": [
                '<script lang="ts">',
                '    // import "$lib/core/state"',
                "    const example = 'import \"$lib/modules/viewer/internal\"'",
                "</script>",
                '<p>import "$lib/features/legacy" {example}</p>',
            ].join("\n"),
        })
        const result = cli(root)
        expect(result.status, result.stderr).toBe(0)
    })

    it("accepts dynamic worker imports with query suffixes", () => {
        const root = fixture(
            {
                "src/lib/modules/viewer/main.ts":
                    'const worker = import("./worker.ts?worker")\nvoid worker\n',
                "src/lib/modules/viewer/worker.ts": "export {}\n",
            },
            ["viewer", "pdf"],
        )
        const result = cli(root)
        expect(result.status, result.stderr).toBe(0)
    })
})

describe("target architecture boundaries", () => {
    it("accepts foundational, extension, and adapter imports", () => {
        const root = fixture({
            "src/lib/core/contracts.ts": "export type CoreContract = string\n",
            "src/lib/core/foundation.ts": [
                'import type { ExtensionContract } from "$lib/extension-api/contracts"',
                'import type { Document } from "$lib/document-model/document"',
                'import type { ExtensionHost } from "$lib/extension-host"',
                "void (0 as unknown as ExtensionContract)",
                "void (0 as unknown as Document)",
                "void (0 as unknown as ExtensionHost)",
            ].join("\n"),
            "src/lib/extension-api/contracts.ts":
                'import type { CoreContract } from "$lib/core/contracts"\nexport type ExtensionContract = CoreContract\n',
            "src/lib/extension-host/document-contracts.ts": [
                'import type { DocumentAdapter } from "../document-model"',
                'import { DocumentAdapterRegistry } from "../core/documents"',
                "void (0 as unknown as DocumentAdapter)",
                "void DocumentAdapterRegistry",
            ].join("\n"),
            "src/lib/extensions/builtin/index.ts": [
                'import type { AppExtension } from "../../extension-api"',
                'import { ExtensionHost } from "../../extension-host"',
                'import { activateViewer } from "./viewer"',
                'import { pdfDocumentAdapter } from "./pdf"',
                "void (0 as unknown as AppExtension)",
                "void ExtensionHost",
                "void activateViewer",
                "void pdfDocumentAdapter",
            ].join("\n"),
            "src/lib/extensions/builtin/viewer/index.ts": [
                'import type { CoreContract } from "$lib/core/contracts"',
                'import type { ExtensionContract } from "$lib/extension-api/contracts"',
                'import "./view.ts"',
                "void (0 as unknown as CoreContract)",
                "void (0 as unknown as ExtensionContract)",
            ].join("\n"),
            "src/lib/extensions/builtin/viewer/view.ts": "export {}\n",
            "src/lib/extensions/builtin/pdf/index.ts": 'import "./adapter"\n',
            "src/lib/extensions/builtin/pdf/adapter/index.ts": [
                'import type { CoreContract } from "$lib/core/contracts"',
                'import type { ExtensionContract } from "$lib/extension-api/contracts"',
                'import type { Document } from "$lib/document-model/document"',
                "void (0 as unknown as CoreContract)",
                "void (0 as unknown as ExtensionContract)",
                "void (0 as unknown as Document)",
            ].join("\n"),
            "src/lib/document-model/document.ts": "export type Document = unknown\n",
        })
        const result = cli(root)
        expect(result.status, result.stderr).toBe(0)
    })

    it("accepts app and route host imports", () => {
        const root = fixture({
            "src/lib/app/AppChrome.svelte": [
                '<script lang="ts">',
                'import type { CoreContract } from "$lib/core/contracts"',
                'import type { ExtensionContract } from "$lib/extension-api/contracts"',
                'import type { ExtensionHost } from "$lib/extension-host"',
                'import type { Document } from "$lib/document-model/document"',
                'import { createBuiltinHost } from "$lib/extensions/builtin"',
                "void (0 as unknown as CoreContract)",
                "void (0 as unknown as ExtensionContract)",
                "void (0 as unknown as ExtensionHost)",
                "void (0 as unknown as Document)",
                "void createBuiltinHost",
                "</script>",
            ].join("\n"),
            "src/routes/+page.svelte": [
                '<script lang="ts">',
                'import { AppShell } from "$lib/app"',
                'import type { ExtensionHost } from "$lib/extension-host"',
                "void AppShell",
                "void (0 as unknown as ExtensionHost)",
                "</script>",
            ].join("\n"),
        })
        const result = cli(root)
        expect(result.status, result.stderr).toBe(0)
    })

    it("accepts builtin plugins importing core-safe shared code", () => {
        const root = fixture({
            "src/lib/extensions/builtin/viewer/main.ts": [
                'import "$lib/shared/ui/Button.svelte"',
                'import "$lib/shared/styles/global.css"',
                'import "$lib/shared/icons/SearchIcon.svelte"',
            ].join("\n"),
        })
        const result = cli(root)
        expect(result.status, result.stderr).toBe(0)
    })

    it.each([
        [
            "app host importing a legacy feature",
            "src/lib/app/AppChrome.svelte",
            '<script lang="ts">import "$lib/modules/viewer"</script>',
            "app host may not import legacy feature internals",
        ],
        [
            "app host importing a plugin",
            "src/lib/app/AppChrome.svelte",
            '<script lang="ts">import "$lib/extensions/builtin/viewer"</script>',
            "app host may only import",
        ],
        [
            "core importing a plugin",
            "src/lib/core/main.ts",
            'import "$lib/extensions/builtin/viewer"',
            "core may only import core",
        ],
        [
            "core importing an adapter",
            "src/lib/core/main.ts",
            'import "$lib/adapters/pdf"',
            "core may only import core",
        ],
        [
            "core importing routes",
            "src/lib/core/main.ts",
            'import "../../routes/+page"',
            "core may only import core",
        ],
        [
            "core importing shared code",
            "src/lib/core/main.ts",
            'import "$lib/shared/state/safeStorage"',
            "core may only import core",
        ],
        [
            "extension API importing a plugin",
            "src/lib/extension-api/main.ts",
            'import "$lib/extensions/builtin/viewer"',
            "extension-api may only import core contracts",
        ],
        [
            "extension host importing shared code",
            "src/lib/extension-host/main.ts",
            'import "$lib/shared/state/safeStorage"',
            "extension-host may only import core, extension-api, and document-model",
        ],
        [
            "extension host importing a plugin",
            "src/lib/extension-host/main.ts",
            'import "$lib/extensions/builtin/viewer"',
            "extension-host may only import core, extension-api, and document-model",
        ],
        [
            "builtin host importing shared code",
            "src/lib/extensions/builtin/index.ts",
            'import "$lib/shared/state/safeStorage"',
            "builtin host may only import host contracts and builtin extensions",
        ],
        [
            "document model importing routes",
            "src/lib/document-model/main.ts",
            'import "../../routes/+page"',
            "document-model may only import core contracts",
        ],
        [
            "shared code importing a plugin",
            "src/lib/shared/main.ts",
            'import "$lib/extensions/builtin/viewer"',
            "shared code may only import core-safe code",
        ],
        [
            "plugin importing another plugin",
            "src/lib/extensions/builtin/viewer/main.ts",
            'import "$lib/extensions/builtin/library"',
            "another extension",
        ],
        [
            "plugin importing an adapter",
            "src/lib/extensions/builtin/viewer/main.ts",
            'import "$lib/extensions/builtin/pdf/adapter"',
            "extensions may not import another extension",
        ],
        [
            "adapter importing a plugin",
            "src/lib/extensions/builtin/pdf/adapter/main.ts",
            'import "$lib/extensions/builtin/viewer"',
            "extensions may not import another extension",
        ],
        [
            "plugin importing non-core-safe shared code",
            "src/lib/extensions/builtin/viewer/main.ts",
            'import "$lib/shared/private/feature"',
            "plugin may not import shared",
        ],
        [
            "adapter importing shared code",
            "src/lib/extensions/builtin/pdf/adapter/main.ts",
            'import "$lib/shared/ui/Button.svelte"',
            "adapter may not import shared",
        ],
        [
            "adapter importing routes",
            "src/lib/extensions/builtin/pdf/adapter/main.ts",
            'import "../../../../../routes/+page"',
            "adapter may not import routes",
        ],
        [
            "route importing a legacy feature",
            "src/routes/+page.ts",
            'import "$lib/modules/viewer"',
            "routes may not import legacy feature internals",
        ],
        [
            "route importing a plugin",
            "src/routes/+page.ts",
            'import "$lib/extensions/builtin/viewer"',
            "routes may only import host-owned code",
        ],
    ])("rejects %s", (_name, file, source, diagnostic) => {
        const root = fixture({ [file]: source })
        const result = cli(root)
        expect(result.status).toBe(1)
        expect(result.stderr).toContain(diagnostic)
    })

    it("rejects deep cross-plugin imports and reports extension cycles", () => {
        const root = fixture({
            "src/lib/extensions/builtin/viewer/main.ts":
                'import "$lib/extensions/builtin/library/internal"',
            "src/lib/extensions/builtin/library/main.ts":
                'import "$lib/extensions/builtin/viewer/internal"',
        })
        const result = analyzeProject(root)
        expect(result.violations.some((violation) => violation.includes("deep-imports"))).toBe(true)
        expect(
            result.violations.some((violation) => violation.includes("extension dependency cycle")),
        ).toBe(true)
    })

    it.each([
        ["commands", "commands.register", "next-page", "viewer.next-page"],
        ["views", "views.registerNative", "outline", "viewer.outline"],
        ["settings", "settings.register", "zoom", "viewer.zoom"],
        ["adapters", "adapters.register", "pdf", "viewer.pdf"],
    ])("requires namespaced %s contribution IDs", (_kind, registration, invalidId, validId) => {
        const receiver = registration.slice(0, registration.indexOf("."))
        const method = registration.slice(registration.indexOf(".") + 1)
        const invalidRoot = fixture({
            "src/lib/extensions/builtin/viewer/main.ts": `context.${receiver}.${method}({ id: "${invalidId}" })`,
        })
        const invalidResult = cli(invalidRoot)
        expect(invalidResult.status).toBe(1)
        expect(invalidResult.stderr).toContain("namespace")

        const validRoot = fixture({
            "src/lib/extensions/builtin/viewer/main.ts": `context.${receiver}.${method}({ id: "${validId}" })`,
        })
        const validResult = cli(validRoot)
        expect(validResult.status, validResult.stderr).toBe(0)
    })
})
