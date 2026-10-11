import type { ExtensionManifest } from "../extension-api"

export class DependencyResolutionError extends Error {
    readonly code = "extension.dependency"

    constructor(
        message: string,
        readonly extensionId?: string,
        options?: { cause?: unknown },
    ) {
        super(message, options)
        this.name = "DependencyResolutionError"
    }
}

export interface ResolvedExtensions {
    readonly order: readonly ExtensionManifest[]
}

export function resolveDependencies(manifests: readonly ExtensionManifest[]): ResolvedExtensions {
    const byId = new Map<string, ExtensionManifest>()
    for (const manifest of manifests) {
        if (byId.has(manifest.id))
            throw new DependencyResolutionError(`Duplicate extension: ${manifest.id}`, manifest.id)
        byId.set(manifest.id, manifest)
    }

    const visiting = new Set<string>()
    const visited = new Set<string>()
    const order: ExtensionManifest[] = []
    const visit = (id: string, chain: readonly string[]): void => {
        if (visited.has(id)) return
        if (visiting.has(id)) {
            const cycleStart = chain.indexOf(id)
            const cycle = [...chain.slice(cycleStart), id]
            throw new DependencyResolutionError(`Dependency cycle: ${cycle.join(" -> ")}`, id)
        }
        const manifest = byId.get(id)
        if (!manifest) throw new DependencyResolutionError(`Missing dependency: ${id}`, id)
        visiting.add(id)
        for (const dependency of Object.keys(manifest.dependencies ?? {}).sort()) {
            const dependencyManifest = byId.get(dependency)
            if (!dependencyManifest) {
                throw new DependencyResolutionError(
                    `Missing dependency ${dependency} required by ${id}`,
                    id,
                )
            }
            const range = manifest.dependencies?.[dependency] ?? "*"
            if (!satisfies(dependencyManifest.version, range)) {
                throw new DependencyResolutionError(
                    `Dependency ${dependency}@${dependencyManifest.version} does not satisfy ${range} required by ${id}`,
                    id,
                )
            }
            visit(dependency, [...chain, id])
        }
        visiting.delete(id)
        visited.add(id)
        order.push(manifest)
    }

    for (const manifest of manifests) visit(manifest.id, [])
    return { order }
}

export function satisfies(version: string, range: string): boolean {
    const actual = parseVersion(version)
    if (!actual) return false
    return range.split("||").some((part) => satisfiesAndRange(actual, part.trim()))
}

function satisfiesAndRange(version: Version, range: string): boolean {
    if (!range || range === "*" || range === "latest") return true
    const tokens = range.split(/\s+/).filter(Boolean)
    return tokens.every((token) => satisfiesToken(version, token))
}

function satisfiesToken(version: Version, token: string): boolean {
    const normalized = token.replace(/^v/, "")
    if (normalized.startsWith("^") || normalized.startsWith("~")) {
        const operator = normalized[0]
        const target = parseVersion(normalized.slice(1))
        if (!target) return false
        if (compare(version, target) < 0) return false
        if (operator === "~")
            return version.major === target.major && version.minor === target.minor
        if (target.major > 0) return version.major === target.major
        if (target.minor > 0)
            return version.major === target.major && version.minor === target.minor
        return (
            version.major === target.major &&
            version.minor === target.minor &&
            version.patch === target.patch
        )
    }
    const match = normalized.match(/^(>=|<=|>|<|=)?(.+)$/)
    if (!match) return false
    const wildcard = match[2].match(/^(\d+)(?:\.(\d+|x|X|\*))?(?:\.(\d+|x|X|\*))?$/)
    if (!match[1] && wildcard && (wildcard[2] ?? "").match(/[xX*]/)) {
        return version.major === Number(wildcard[1])
    }
    if (!match[1] && wildcard && (wildcard[3] ?? "").match(/[xX*]/)) {
        return version.major === Number(wildcard[1]) && version.minor === Number(wildcard[2])
    }
    const target = parseVersion(match[2])
    if (!target) return false
    const comparison = compare(version, target)
    switch (match[1]) {
        case ">=":
            return comparison >= 0
        case "<=":
            return comparison <= 0
        case ">":
            return comparison > 0
        case "<":
            return comparison < 0
        default:
            return comparison === 0
    }
}

type Version = { major: number; minor: number; patch: number }

function parseVersion(value: string): Version | undefined {
    const match = value
        .trim()
        .match(/^(\d+)(?:\.(\d+|x|X|\*))?(?:\.(\d+|x|X|\*))?(?:-[0-9A-Za-z.-]+)?$/)
    if (!match) return undefined
    return {
        major: Number(match[1]),
        minor: match[2] && !/[xX*]/.test(match[2]) ? Number(match[2]) : 0,
        patch: match[3] && !/[xX*]/.test(match[3]) ? Number(match[3]) : 0,
    }
}

function compare(left: Version, right: Version): number {
    return left.major - right.major || left.minor - right.minor || left.patch - right.patch
}
