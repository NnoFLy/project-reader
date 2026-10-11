import { describe, expect, it } from "vitest"
import { DependencyResolutionError, resolveDependencies } from "./dependency-resolution"
import type { ExtensionManifest } from "../extension-api"

const extension = (id: string, dependencies?: Record<string, string>): ExtensionManifest => ({
    id,
    name: id,
    version: "1.0.0",
    engine: "*",
    entry: id,
    activationEvents: [],
    permissions: [],
    dependencies,
})

describe("extension dependency resolution", () => {
    it("orders dependencies before dependants", () => {
        const result = resolveDependencies([
            extension("builtin.viewer", { "builtin.core": "^1.0.0" }),
            extension("builtin.core"),
        ])
        expect(result.order.map((item) => item.id)).toEqual(["builtin.core", "builtin.viewer"])
    })

    it("reports cycles before activation", () => {
        expect(() =>
            resolveDependencies([
                extension("builtin.a", { "builtin.b": "1.0.0" }),
                extension("builtin.b", { "builtin.a": "1.0.0" }),
            ]),
        ).toThrow(DependencyResolutionError)
    })
})
