import fs from "node:fs"
import path from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"
import ts from "typescript"
import { parse as parseSvelte } from "svelte/compiler"

export const DEFAULT_ALLOWED_DEPENDENCIES = {
    commands: [],
    documents: ["pdf"],
    library: ["commands", "documents", "notifications", "pdf", "prompt", "settings"],
    notifications: [],
    pdf: ["settings"],
    prompt: ["commands"],
    settings: ["commands", "prompt"],
    viewer: ["commands", "documents", "pdf", "prompt", "settings"],
}

const TARGET_LAYERS = new Set([
    "core",
    "extension-api",
    "extension-host",
    "app-host",
    "builtin-host",
    "document-model",
    "plugin",
    "adapter",
    "shared",
    "routes",
])
const CONTRIBUTION_METHODS = new Map([
    ["commands", "command"],
    ["command", "command"],
    ["views", "view"],
    ["view", "view"],
    ["settings", "setting"],
    ["setting", "setting"],
    ["documents", "adapter"],
    ["document", "adapter"],
    ["adapters", "adapter"],
    ["adapter", "adapter"],
])

function walk(directory) {
    if (!fs.existsSync(directory)) return []
    return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const target = path.join(directory, entry.name)
        if (entry.isDirectory()) return walk(target)
        return /\.(?:js|mjs|ts|svelte)$/.test(entry.name) ? [target] : []
    })
}

function scriptSources(file, source) {
    if (!file.endsWith(".svelte")) return [source]
    const ast = parseSvelte(source, { filename: file, modern: true })
    return [ast.module?.content, ast.instance?.content]
        .filter(Boolean)
        .map((script) => source.slice(script.start, script.end))
}

function sourceFiles(file, source) {
    return scriptSources(file, source).map((script) =>
        ts.createSourceFile(file, script, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS),
    )
}

function importSpecifiers(file, source) {
    const specifiers = []
    for (const sourceFile of sourceFiles(file, source)) {
        const visit = (node) => {
            if (
                (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
                node.moduleSpecifier &&
                ts.isStringLiteralLike(node.moduleSpecifier)
            ) {
                specifiers.push(node.moduleSpecifier.text)
            } else if (
                ts.isCallExpression(node) &&
                node.expression.kind === ts.SyntaxKind.ImportKeyword &&
                node.arguments.length === 1 &&
                ts.isStringLiteralLike(node.arguments[0])
            ) {
                specifiers.push(node.arguments[0].text)
            }
            ts.forEachChild(node, visit)
        }
        visit(sourceFile)
    }
    return specifiers
}

function propertyName(node) {
    if (!node.name) return null
    if (ts.isIdentifier(node.name) || ts.isStringLiteralLike(node.name)) return node.name.text
    return null
}

function staticStringProperty(object, name) {
    for (const property of object.properties) {
        if (!ts.isPropertyAssignment(property) || propertyName(property) !== name) continue
        return ts.isStringLiteralLike(property.initializer) ? property.initializer.text : null
    }
    return null
}

function registrationCategory(expression) {
    if (!ts.isPropertyAccessExpression(expression)) return null
    const method = expression.name.text.toLowerCase()
    if (!method.startsWith("register")) return null
    const receiver = expression.expression
    const receiverName = ts.isPropertyAccessExpression(receiver)
        ? receiver.name.text
        : ts.isIdentifier(receiver)
          ? receiver.text
          : null
    const receiverCategory = receiverName
        ? CONTRIBUTION_METHODS.get(receiverName.toLowerCase())
        : undefined
    if (receiverCategory) return receiverCategory
    if (method.includes("command")) return "command"
    if (method.includes("view")) return "view"
    if (method.includes("setting")) return "setting"
    if (method.includes("adapter") || method.includes("document")) return "adapter"
    return null
}

function contributionIds(file, source) {
    const contributions = []
    for (const sourceFile of sourceFiles(file, source)) {
        const visit = (node) => {
            if (ts.isCallExpression(node)) {
                const category = registrationCategory(node.expression)
                const argument = node.arguments[0]
                if (category && argument && ts.isObjectLiteralExpression(argument)) {
                    const id = staticStringProperty(argument, "id")
                    if (id) contributions.push({ category, id })
                }
            }

            // Also inspect the declarative manifest shape described by the extension API.
            if (
                ts.isPropertyAssignment(node) &&
                propertyName(node) === "contributes" &&
                ts.isObjectLiteralExpression(node.initializer)
            ) {
                for (const contributionGroup of node.initializer.properties) {
                    if (!ts.isPropertyAssignment(contributionGroup)) continue
                    const category = CONTRIBUTION_METHODS.get(
                        propertyName(contributionGroup)?.toLowerCase() ?? "",
                    )
                    if (!category) continue
                    const values = ts.isArrayLiteralExpression(contributionGroup.initializer)
                        ? contributionGroup.initializer.elements
                        : [contributionGroup.initializer]
                    for (const value of values) {
                        if (!ts.isObjectLiteralExpression(value)) continue
                        const id = staticStringProperty(value, "id")
                        if (id) contributions.push({ category, id })
                    }
                }
            }
            ts.forEachChild(node, visit)
        }
        visit(sourceFile)
    }
    return contributions
}

function targetArea(sourceRoot, file) {
    const relative = path.relative(sourceRoot, file).replaceAll(path.sep, "/")
    if (relative === "lib/core" || relative.startsWith("lib/core/")) return { kind: "core" }
    if (relative === "lib/extension-api" || relative.startsWith("lib/extension-api/")) {
        return { kind: "extension-api" }
    }
    if (relative === "lib/extension-host" || relative.startsWith("lib/extension-host/")) {
        return { kind: "extension-host" }
    }
    if (relative === "lib/document-model" || relative.startsWith("lib/document-model/")) {
        return { kind: "document-model" }
    }
    if (relative === "lib/app" || relative.startsWith("lib/app/")) {
        return { kind: "app-host" }
    }
    if (relative === "lib/shared" || relative.startsWith("lib/shared/")) {
        return { kind: "shared" }
    }
    if (relative === "routes" || relative.startsWith("routes/")) return { kind: "routes" }

    // The builtin extension registry composes extensions into the host.
    if (relative === "lib/extensions/builtin" || relative === "lib/extensions/builtin/index.ts") {
        return { kind: "builtin-host" }
    }

    const adapterMatch = relative.match(
        /^lib\/(?:adapters|extensions\/builtin\/([^/]+)\/adapter(?:s)?)(?:\/|$)/,
    )
    if (adapterMatch) {
        const name = adapterMatch[1] ?? relative.split("/")[2]
        return { kind: "adapter", name }
    }

    const pluginMatch = relative.match(/^lib\/extensions\/builtin\/([^/]+)(?:\/|$)/)
    if (pluginMatch) return { kind: "plugin", name: pluginMatch[1] }
    return null
}

function targetBoundaryViolation(from, to) {
    if (["app-host", "routes"].includes(from.kind) && to.kind === "module") {
        return `${from.kind === "app-host" ? "app host" : "routes"} may not import legacy feature internals`
    }
    if (!TARGET_LAYERS.has(from.kind) || !TARGET_LAYERS.has(to.kind)) return null
    const allowedTargets = {
        core: ["core", "extension-api", "extension-host", "document-model"],
        "extension-api": ["core", "extension-api", "document-model"],
        "extension-host": ["core", "extension-api", "extension-host", "document-model"],
        "app-host": [
            "app-host",
            "core",
            "extension-api",
            "extension-host",
            "builtin-host",
            "document-model",
        ],
        "builtin-host": [
            "core",
            "extension-api",
            "extension-host",
            "builtin-host",
            "document-model",
            "plugin",
            "adapter",
        ],
        "document-model": ["core", "document-model"],
    }
    const boundaryMessages = {
        core: "core may only import core, extension-api, extension-host, and document-model",
        "extension-api": "extension-api may only import core contracts",
        "extension-host": "extension-host may only import core, extension-api, and document-model",
        "app-host":
            "app host may only import app host, core, extension-api, extension-host, builtin host, and document-model",
        "builtin-host": "builtin host may only import host contracts and builtin extensions",
        "document-model": "document-model may only import core contracts",
    }
    if (allowedTargets[from.kind] && !allowedTargets[from.kind].includes(to.kind)) {
        return boundaryMessages[from.kind]
    }
    if (from.kind === "shared" && !["core", "document-model", "shared"].includes(to.kind)) {
        return "shared code may only import core-safe code"
    }
    if (
        from.kind === "routes" &&
        !["core", "extension-host", "app-host", "routes"].includes(to.kind)
    ) {
        return "routes may only import host-owned code"
    }
    if (["plugin", "adapter"].includes(from.kind)) {
        if (["core", "extension-api", "document-model"].includes(to.kind)) return null
        if (
            ["plugin", "adapter"].includes(to.kind) &&
            from.name === to.name &&
            (to.kind === from.kind || (from.kind === "plugin" && to.kind === "adapter"))
        ) {
            return null
        }
        if (["plugin", "adapter"].includes(to.kind) && from.name !== to.name) {
            return `extensions may not import another extension (${to.name})`
        }
        return `${from.kind} may not import ${to.kind}`
    }
    return null
}

function contributionViolation(file, from, id, category) {
    if (!from || !["plugin", "adapter"].includes(from.kind)) return null
    const namespace = from.name
    if (id.startsWith(`${namespace}.`) || id.startsWith(`builtin.${namespace}.`)) return null
    return `${file}: ${category} contribution ID "${id}" must use the ${namespace} namespace`
}

export function analyzeProject(projectRoot, allowedDependencies = DEFAULT_ALLOWED_DEPENDENCIES) {
    const sourceRoot = path.join(projectRoot, "src")
    const libRoot = path.join(sourceRoot, "lib")
    const modulesRoot = path.join(libRoot, "modules")
    const location = (file) => path.relative(projectRoot, file).replaceAll(path.sep, "/")
    const legacyArea = (file) => {
        const relative = path.relative(sourceRoot, file).replaceAll(path.sep, "/")
        const moduleMatch = relative.match(/^lib\/modules\/([^/]+)(?:\/|$)/)
        if (moduleMatch) return { kind: "module", name: moduleMatch[1] }
        if (relative.startsWith("lib/shared/")) return { kind: "shared" }
        if (relative.startsWith("lib/app/")) return { kind: "app" }
        if (relative.startsWith("lib/paraglide/")) return { kind: "paraglide" }
        if (relative.startsWith("routes/")) return { kind: "routes" }
        return { kind: "other" }
    }
    const area = (file) => targetArea(sourceRoot, file) ?? legacyArea(file)
    const resolveImport = (importer, rawSpecifier) => {
        const specifier = rawSpecifier.split("?")[0]
        if (specifier.startsWith("$lib/")) return path.join(libRoot, specifier.slice(5))
        if (specifier.startsWith("./") || specifier.startsWith("../")) {
            return path.resolve(path.dirname(importer), specifier)
        }
        return null
    }

    const files = walk(sourceRoot)
    const violations = []
    const moduleNames = fs.existsSync(modulesRoot)
        ? fs
              .readdirSync(modulesRoot, { withFileTypes: true })
              .filter((entry) => entry.isDirectory())
              .map((entry) => entry.name)
        : []
    const graph = new Map(moduleNames.map((name) => [name, new Set()]))
    const extensionGraph = new Map()
    const ensureExtensionNode = (name) => {
        if (!extensionGraph.has(name)) extensionGraph.set(name, new Set())
    }

    for (const moduleName of moduleNames) {
        if (!fs.existsSync(path.join(modulesRoot, moduleName, "index.ts"))) {
            violations.push(`src/lib/modules/${moduleName}: module is missing index.ts`)
        }
    }

    for (const file of files) {
        const source = fs.readFileSync(file, "utf8")
        const from = area(file)
        for (const { category, id } of contributionIds(file, source)) {
            const violation = contributionViolation(location(file), from, id, category)
            if (violation) violations.push(violation)
        }
        for (const specifier of importSpecifiers(file, source)) {
            const cleanSpecifier = specifier.split("?")[0]
            const targetPath = resolveImport(file, specifier)
            const to = targetPath ? area(targetPath) : { kind: "external" }

            if (
                /^\$lib\/(?:core|features)(?:\/|$)/.test(cleanSpecifier) &&
                !targetArea(sourceRoot, file)
            ) {
                violations.push(`${location(file)} imports removed alias ${specifier}`)
            }

            const moduleAlias = cleanSpecifier.match(/^\$lib\/modules\/([^/]+)(\/.+)$/)
            if (moduleAlias) {
                violations.push(
                    from.kind === "module" && from.name === moduleAlias[1]
                        ? `${location(file)} uses an alias for its own internals; use a relative import`
                        : `${location(file)} deep-imports ${specifier}; use $lib/modules/${moduleAlias[1]}`,
                )
            }

            const pluginAlias = cleanSpecifier.match(/^\$lib\/extensions\/builtin\/([^/]+)(\/.+)$/)
            if (pluginAlias) {
                violations.push(
                    `${location(file)} deep-imports ${specifier}; use $lib/extensions/builtin/${pluginAlias[1]}`,
                )
            }
            const adapterAlias = cleanSpecifier.match(/^\$lib\/adapters\/([^/]+)(\/.+)$/)
            if (adapterAlias) {
                violations.push(
                    `${location(file)} deep-imports ${specifier}; use $lib/adapters/${adapterAlias[1]}`,
                )
            }

            if (
                from.kind === "shared" &&
                ["module", "app", "app-host", "routes"].includes(to.kind)
            ) {
                violations.push(`${location(file)}: shared code may not import ${specifier}`)
            }
            if (from.kind === "module" && ["app", "app-host", "routes"].includes(to.kind)) {
                violations.push(`${location(file)}: modules may not import ${specifier}`)
            }
            if (
                from.kind === "paraglide" &&
                ["module", "shared", "app", "app-host", "routes"].includes(to.kind)
            ) {
                violations.push(
                    `${location(file)}: generated Paraglide code imports application code (${specifier})`,
                )
            }

            const targetViolation = targetBoundaryViolation(from, to)
            if (targetViolation) violations.push(`${location(file)}: ${targetViolation}`)

            if (from.kind === "module" && to.kind === "module" && from.name !== to.name) {
                graph.get(from.name)?.add(to.name)
                if (!(allowedDependencies[from.name] ?? []).includes(to.name)) {
                    violations.push(`${location(file)}: ${from.name} may not depend on ${to.name}`)
                }
                if (cleanSpecifier !== `$lib/modules/${to.name}`) {
                    violations.push(
                        `${location(file)}: cross-module imports must use $lib/modules/${to.name}`,
                    )
                }
            }

            if (
                ["plugin", "adapter"].includes(from.kind) &&
                ["plugin", "adapter"].includes(to.kind) &&
                from.name !== to.name
            ) {
                ensureExtensionNode(from.name)
                ensureExtensionNode(to.name)
                extensionGraph.get(from.name).add(to.name)
            }
        }
    }

    const visiting = new Set()
    const visited = new Set()
    const visit = (moduleName, trail = []) => {
        if (visiting.has(moduleName)) {
            const start = trail.indexOf(moduleName)
            violations.push(
                `module dependency cycle: ${[...trail.slice(start), moduleName].join(" -> ")}`,
            )
            return
        }
        if (visited.has(moduleName)) return
        visiting.add(moduleName)
        for (const dependency of graph.get(moduleName) ?? [])
            visit(dependency, [...trail, moduleName])
        visiting.delete(moduleName)
        visited.add(moduleName)
    }
    for (const moduleName of graph.keys()) visit(moduleName)

    const extensionVisiting = new Set()
    const extensionVisited = new Set()
    const visitExtension = (name, trail = []) => {
        if (extensionVisiting.has(name)) {
            const start = trail.indexOf(name)
            violations.push(
                `extension dependency cycle: ${[...trail.slice(start), name].join(" -> ")}`,
            )
            return
        }
        if (extensionVisited.has(name)) return
        extensionVisiting.add(name)
        for (const dependency of extensionGraph.get(name) ?? [])
            visitExtension(dependency, [...trail, name])
        extensionVisiting.delete(name)
        extensionVisited.add(name)
    }
    for (const name of extensionGraph.keys()) visitExtension(name)

    return {
        files: files.length,
        modules: graph.size,
        violations: [...new Set(violations)].sort(),
    }
}

export function runCli(projectRoot = process.cwd()) {
    const result = analyzeProject(projectRoot)
    if (result.violations.length) {
        console.error(`Module boundary check failed with ${result.violations.length} violation(s):`)
        for (const violation of result.violations) console.error(`- ${violation}`)
        return 1
    }
    console.log(
        `Module boundaries valid (${result.files} source files, ${result.modules} modules).`,
    )
    return 0
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isCli) process.exitCode = runCli()
