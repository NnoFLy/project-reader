import type { Disposable, ViewSlot, RegisteredView } from "../../extension-api"

export type WorkbenchSlot = ViewSlot

export interface WorkbenchRouteSurface {
    readonly route: string
    readonly slots: readonly WorkbenchSlot[]
    views(slot: WorkbenchSlot): readonly RegisteredView[]
    subscribe(listener: (slot: WorkbenchSlot) => void): Disposable
}

export class WorkbenchSurface implements WorkbenchRouteSurface {
    private readonly listeners = new Set<(slot: WorkbenchSlot) => void>()

    constructor(
        readonly route: string,
        private readonly viewProvider: (slot: WorkbenchSlot) => readonly RegisteredView[],
        readonly slots: readonly WorkbenchSlot[],
    ) {}

    views(slot: WorkbenchSlot): readonly RegisteredView[] {
        return this.viewProvider(slot)
    }

    notify(slot: WorkbenchSlot): void {
        for (const listener of this.listeners) listener(slot)
    }

    subscribe(listener: (slot: WorkbenchSlot) => void): Disposable {
        this.listeners.add(listener)
        return {
            dispose: () => {
                this.listeners.delete(listener)
            },
        }
    }
}

export const STATIC_WORKBENCH_ROUTES = ["/", "/viewer/:documentId", "/extensions"] as const
