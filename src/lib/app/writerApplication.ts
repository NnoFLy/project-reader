import type { Application } from "../core/app"
import type { Disposable } from "../extension-api"
import { IndexedDBWriteLifetime } from "../core/storage"

export type WriterApplicationState =
    | "idle"
    | "acquiring"
    | "starting"
    | "running"
    | "blocked"
    | "unsupported"
    | "failed"
    | "stopping"
    | "stopped"
    | "recovery-required"

/** One stable lock for the actual, single persistent Library, not a browser-tab identity. */
export const LIBRARY_WRITER_LOCK = "project-reader:library:vfs-extension-storage:writer"

interface WriterAttempt {
    readonly controller: AbortController
    readonly lifetime: IndexedDBWriteLifetime
    readonly release: () => void
    application?: Application
    active: boolean
    stop?: Promise<void>
}

export interface WriterDeadlines {
    readonly acquisitionMs?: number
    readonly startupMs?: number
    readonly shutdownMs?: number
}

/** Application-owned gate. Only bootstrap supplies the trusted composition factory. */
export class WriterApplication {
    private currentState: WriterApplicationState = "idle"
    private readonly listeners = new Set<(state: WriterApplicationState) => void>()
    private attempt?: WriterAttempt
    private startup?: Promise<void>

    constructor(
        private readonly createApplication: (lifetime: IndexedDBWriteLifetime) => Application,
        private readonly deadlines: WriterDeadlines = {},
    ) {}

    get state(): WriterApplicationState {
        return this.currentState
    }

    get ready(): boolean {
        return this.state === "running" && this.attempt?.active === true
    }

    get application(): Application | undefined {
        return this.ready ? this.attempt?.application : undefined
    }

    onStateChange(listener: (state: WriterApplicationState) => void): Disposable {
        this.listeners.add(listener)
        return {
            dispose: () => {
                this.listeners.delete(listener)
            },
        }
    }

    start(): Promise<void> {
        if (this.startup) return this.startup
        if (this.ready || this.attempt) return Promise.resolve()
        const operation = completion<void>()
        this.startup = operation.promise
        const clearStartup = () => {
            if (this.startup === operation.promise) this.startup = undefined
        }
        void operation.promise.then(clearStartup, clearStartup)
        void this.acquireAndStart().then(operation.resolve, operation.reject)
        return operation.promise
    }

    stop(): Promise<void> {
        const attempt = this.attempt
        if (!attempt) {
            this.setState("stopped")
            return Promise.resolve()
        }
        return this.shutdown(attempt, "stopped")
    }

    async executeCommand(commandId: string, payload?: unknown): Promise<unknown> {
        const application = this.application
        if (!application) throw new Error("Library writer is not running")
        return application.host.commands.execute(commandId, payload)
    }

    private async acquireAndStart(): Promise<void> {
        const controller = new AbortController()
        let release!: () => void
        const held = new Promise<void>((resolve) => {
            release = resolve
        })
        const attempt: WriterAttempt = {
            controller,
            lifetime: new IndexedDBWriteLifetime(controller.signal),
            release,
            active: true,
        }
        this.attempt = attempt
        this.setState("acquiring")
        if (!attempt.active) return
        try {
            const locks = navigator.locks
            if (!locks || typeof locks.request !== "function") {
                await this.shutdown(attempt, "unsupported")
                return
            }
            let acquired!: (value: boolean) => void
            let rejected!: (error: unknown) => void
            const acquisition = new Promise<boolean>((resolve, reject) => {
                acquired = resolve
                rejected = reject
            })
            let holding = false
            const request = locks.request(
                `${location.origin}:${LIBRARY_WRITER_LOCK}`,
                // Web Locks rejects signal + ifAvailable; cancellation is fenced in the callback.
                { mode: "exclusive", ifAvailable: true },
                (lock) => {
                    if (!lock || !attempt.active) {
                        acquired(false)
                        return
                    }
                    holding = true
                    acquired(true)
                    return held
                },
            )
            const unexpectedSettlement = () => {
                if (holding && attempt.active) void this.shutdown(attempt, "failed")
            }
            void request.then(unexpectedSettlement, (error) => {
                rejected(error)
                unexpectedSettlement()
            })
            const owned = await deadline(
                acquisition,
                this.deadlines.acquisitionMs ?? 3000,
                controller.signal,
            )
            if (!attempt.active) return
            if (!owned) {
                await this.shutdown(attempt, "blocked")
                return
            }
            this.setState("starting")
            if (!attempt.active) return
            attempt.application = this.createApplication(attempt.lifetime)
            await deadline(
                attempt.application.start(),
                this.deadlines.startupMs ?? 15000,
                controller.signal,
            )
            if (!attempt.active || this.attempt !== attempt) return
            const failed = attempt.application.host.records.some(
                ({ manifest, state }) =>
                    manifest.activationEvents.some((event) => event.type === "startup") &&
                    state !== "active",
            )
            if (failed) throw new Error("Required startup extension did not activate")
            this.setState("running")
        } catch {
            if (attempt.active) await this.shutdown(attempt, "failed")
        }
    }

    private shutdown(attempt: WriterAttempt, outcome: WriterApplicationState): Promise<void> {
        if (attempt.stop) return attempt.stop
        const operation = completion<void>()
        attempt.stop = operation.promise
        // Revoke synchronously, before awaiting host disposal or physical transaction drain.
        attempt.active = false
        this.setState("stopping")
        attempt.controller.abort()
        const quiescent = attempt.lifetime.whenQuiescent().then(attempt.release)
        let disposal: Promise<void>
        try {
            disposal = attempt.application?.stop() ?? Promise.resolve()
        } catch (error) {
            disposal = Promise.reject(error)
        }
        const cleanup = Promise.all([quiescent, disposal])
        void deadline(cleanup, this.deadlines.shutdownMs ?? 3000)
            .then(() => {
                if (this.attempt !== attempt) return
                this.attempt = undefined
                this.setState(outcome)
            })
            .catch(() => {
                if (this.attempt === attempt) this.setState("recovery-required")
            })
            .then(operation.resolve, operation.reject)
        return operation.promise
    }

    private setState(state: WriterApplicationState): void {
        this.currentState = state
        for (const listener of this.listeners) listener(state)
    }
}

function completion<T>() {
    let resolve!: (value: T) => void
    let reject!: (error: unknown) => void
    const promise = new Promise<T>((done, fail) => {
        resolve = done
        reject = fail
    })
    return { promise, resolve, reject }
}

function deadline<T>(
    operation: Promise<T>,
    milliseconds: number,
    signal?: AbortSignal,
): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const cleanup = () => {
            clearTimeout(timer)
            signal?.removeEventListener("abort", abort)
        }
        const succeed = (value: T) => {
            cleanup()
            resolve(value)
        }
        const fail = (error: unknown) => {
            cleanup()
            reject(error)
        }
        const abort = () => fail(signal?.reason)
        const timer = setTimeout(
            () => fail(new Error("Application operation timed out")),
            milliseconds,
        )
        signal?.addEventListener("abort", abort, { once: true })
        if (signal?.aborted) abort()
        operation.then(succeed, fail)
    })
}
