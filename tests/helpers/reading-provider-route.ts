import { mount } from "svelte"
import ViewerRoute from "../../src/lib/app/routes/ViewerRoute.svelte"

// Vite resolves these static imports together so mount and the route share Svelte's runtime.
export function mountReadingProviderRoute(target: HTMLElement, context: Map<unknown, unknown>) {
    return mount(ViewerRoute, { target, context })
}
