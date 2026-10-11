import type { Disposable } from "../../extension-api"
import type { StaticRouteSurface } from "./index"

/** Route hosts are static; extensions contribute views to these surfaces, not routes. */
export const HOST_OWNED_ROUTE_PATHS = ["/", "/viewer/:documentId", "/extensions"] as const

export class StaticRouteSurfaceRegistry {
    private readonly surfaces = new Map<string, StaticRouteSurface>()

    register<TView>(surface: StaticRouteSurface<TView>): Disposable {
        if (
            !HOST_OWNED_ROUTE_PATHS.includes(
                surface.path as (typeof HOST_OWNED_ROUTE_PATHS)[number],
            )
        ) {
            throw new Error(`Route is not host-owned: ${surface.path}`)
        }
        if (this.surfaces.has(surface.path))
            throw new Error(`Route surface is already registered: ${surface.path}`)
        this.surfaces.set(surface.path, surface)
        let active = true
        return {
            dispose: () => {
                if (!active) return
                active = false
                this.surfaces.delete(surface.path)
            },
        }
    }

    get(path: string): StaticRouteSurface | undefined {
        return this.surfaces.get(path)
    }

    list(): readonly StaticRouteSurface[] {
        return [...this.surfaces.values()]
    }
}
