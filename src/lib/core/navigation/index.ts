import type { Disposable } from "../../extension-api"
export * from "./route-surfaces"

export interface NavigationTarget {
    readonly path: string
    readonly replace?: boolean
    readonly state?: unknown
}

export interface NavigationService {
    current(): NavigationTarget | undefined
    navigate(target: NavigationTarget): Promise<void>
    subscribe(listener: (target: NavigationTarget) => void): Disposable
}

export class NavigationServiceImpl implements NavigationService {
    private target: NavigationTarget | undefined
    private readonly listeners = new Set<(target: NavigationTarget) => void>()

    current(): NavigationTarget | undefined {
        return this.target
    }

    async navigate(target: NavigationTarget): Promise<void> {
        if (!target.path.startsWith("/"))
            throw new Error(`Navigation path must be absolute: ${target.path}`)
        this.target = target
        for (const listener of this.listeners) listener(target)
    }

    subscribe(listener: (target: NavigationTarget) => void): Disposable {
        this.listeners.add(listener)
        return {
            dispose: () => {
                this.listeners.delete(listener)
            },
        }
    }
}

/** Contract implemented by static SvelteKit routes without making routes dynamic. */
export interface StaticRouteSurface<TView = unknown> {
    readonly path: string
    render(context: StaticRouteContext): TView | undefined
}

export interface StaticRouteContext {
    readonly route: string
    readonly parameters?: Readonly<Record<string, string>>
}
