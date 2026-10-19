import type { ModalCloseReason, ModalState } from "./modal.types"

export type ModalRecord = {
    id: string
    state: ModalState
    element: HTMLElement | null
    close: (reason: ModalCloseReason) => void
    restoreFocusTo: HTMLElement | null
    openedAt: number
    zOrder: number
}

type RegisterModalRecord = Omit<ModalRecord, "openedAt" | "zOrder">

export class ModalManager {
    #records = $state.raw<ModalRecord[]>([])
    #openedCounter = 0
    #bodyOverflow: string | null = null

    get records(): readonly ModalRecord[] {
        return this.#records
    }

    get topmostModal(): ModalRecord | null {
        return this.#records.at(-1) ?? null
    }

    get topmostBlockingModal(): ModalRecord | null {
        return this.#records.findLast((record) => record.state === "blocking") ?? null
    }

    get hasBlockingModal(): boolean {
        return this.#records.some((record) => record.state === "blocking")
    }

    get hasAnyModal(): boolean {
        return this.#records.length > 0
    }

    get(id: string): ModalRecord | null {
        return this.#records.find((record) => record.id === id) ?? null
    }

    register(record: RegisterModalRecord): () => ModalRecord | null {
        if (this.get(record.id))
            throw new Error(`A Modal with id "${record.id}" is already mounted`)
        this.#records = this.#normalize([
            ...this.#records,
            { ...record, openedAt: ++this.#openedCounter, zOrder: this.#records.length },
        ])
        this.#syncApplicationState()
        return () => this.unregister(record.id)
    }

    unregister(id: string): ModalRecord | null {
        const removed = this.get(id)
        if (!removed) return null
        this.#records = this.#normalize(this.#records.filter((record) => record.id !== id))
        this.#syncApplicationState()
        return removed
    }

    updateElement(id: string, element: HTMLElement | null): void {
        this.#update(id, (record) => ({ ...record, element }))
    }

    bringToFront(id: string): void {
        const record = this.get(id)
        if (!record || this.topmostModal?.id === id) return
        this.#records = this.#normalize([
            ...this.#records.filter((candidate) => candidate.id !== id),
            record,
        ])
    }

    focus(id: string): void {
        const record = this.get(id)
        if (!record) return
        this.bringToFront(id)
        record.element?.focus()
    }

    setModeless(id: string): void {
        this.#update(id, (record) => ({ ...record, state: "modeless" }))
        this.bringToFront(id)
        this.#syncApplicationState()
    }

    requestClose(id: string, reason: ModalCloseReason): void {
        this.get(id)?.close(reason)
    }

    zIndex(id: string): number {
        return 1000 + (this.get(id)?.zOrder ?? 0) * 2
    }

    reset(): void {
        this.#records = []
        this.#openedCounter = 0
        this.#syncApplicationState()
    }

    #update(id: string, update: (record: ModalRecord) => ModalRecord): void {
        let found = false
        this.#records = this.#records.map((record) => {
            if (record.id !== id) return record
            found = true
            return update(record)
        })
        if (!found) throw new Error(`Unknown Modal id "${id}"`)
    }

    #normalize(records: ModalRecord[]): ModalRecord[] {
        return records.map((record, zOrder) => ({ ...record, zOrder }))
    }

    #syncApplicationState(): void {
        if (typeof document === "undefined") return
        const appRoot = document.getElementById("app-root")
        const blocked = this.hasBlockingModal
        if (appRoot) appRoot.inert = blocked

        if (blocked && this.#bodyOverflow === null) {
            this.#bodyOverflow = document.body.style.overflow
            document.body.style.overflow = "hidden"
        } else if (!blocked && this.#bodyOverflow !== null) {
            document.body.style.overflow = this.#bodyOverflow
            this.#bodyOverflow = null
        }
    }
}

export const modalManager = new ModalManager()

if (import.meta.hot) import.meta.hot.dispose(() => modalManager.reset())
