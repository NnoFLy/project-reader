type RelinkCompletion = () => void | Promise<void>

export class RelinkRequestState {
    nodeId = $state<string | null>(null)
    #onComplete: RelinkCompletion | null = null

    request(nodeId: string, onComplete?: RelinkCompletion): void {
        this.nodeId = nodeId
        this.#onComplete = onComplete ?? null
    }

    cancel(): void {
        this.nodeId = null
        this.#onComplete = null
    }

    async complete(): Promise<void> {
        const onComplete = this.#onComplete
        this.cancel()
        await onComplete?.()
    }
}

export let relinkRequest = new RelinkRequestState()

export function installRelinkRequest(request: RelinkRequestState): void {
    relinkRequest = request
}

export function requestLibraryRelink(nodeId: string, onComplete?: RelinkCompletion): void {
    relinkRequest.request(nodeId, onComplete)
}
