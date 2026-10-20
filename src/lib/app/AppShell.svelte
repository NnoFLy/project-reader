<script lang="ts">
    import { onMount, setContext } from "svelte"
    import AppChrome from "./AppChrome.svelte"
    import { createBrowserApplication } from "./bootstrap"
    import WriterFeedback from "./WriterFeedback.svelte"
    import type { WriterApplicationState } from "./writerApplication"
    import { APP_HOST_CONTEXT, type AppHostContext } from "./hostContext"
    import {
        commandsStore,
        findKeybindingConflicts,
        getActiveKeydownHandler,
        KeyboardHandler,
        normalizeKeybinding,
        resolveHostKeybindings,
    } from "$lib/core/commands"

    let { children } = $props()
    const writer = createBrowserApplication()
    let gateState = $state<WriterApplicationState>(writer.state)
    let mountFailed = $state(false)
    let suspended = $state(false)
    let ready = $derived(gateState === "running" && !mountFailed && !suspended)
    const hostContext: AppHostContext = {
        get application() {
            const application = writer.application
            if (!application || !ready) throw new Error("Library writer is not running")
            return application
        },
        services: {
            executeCommand: (commandId, payload) => {
                if (!ready) return Promise.reject(new Error("Library writer is not running"))
                return writer.executeCommand(commandId, payload)
            },
        },
        get ready() {
            return ready
        },
    }
    setContext(APP_HOST_CONTEXT, hostContext)
    setContext("app-host-services", hostContext.services)

    function eventKeyCandidates(event: KeyboardEvent): ReadonlySet<string> {
        return KeyboardHandler.candidates(event)
    }

    function failMount() {
        mountFailed = true
        void writer.stop()
    }

    function start() {
        if (suspended) return
        mountFailed = false
        void writer.start().catch(failMount)
    }

    function handlePagehide() {
        suspended = true
        void writer.stop()
    }

    function reload() {
        handlePagehide()
        window.location.reload()
    }

    function handlePageshow(event: PageTransitionEvent) {
        // BFCache must never revive a revoked host, backend, or command capability.
        if (event.persisted) reload()
    }

    onMount(() => {
        const subscription = writer.onStateChange((next) => {
            gateState = next
        })
        const handleKeydown = async (event: KeyboardEvent) => {
            const application = writer.application
            if (!ready || !application) return

            // Component command scopes own viewer and prompt shortcuts. Dispatch them before
            // host-level bindings so scoped commands can intentionally shadow global ones.
            if (commandsStore.canHandleKeydown(event)) {
                event.stopImmediatePropagation()
                await commandsStore.handleKeydown(event)
                return
            }

            const activeKeydownHandler = getActiveKeydownHandler(event)
            if (activeKeydownHandler) {
                event.stopImmediatePropagation()
                await activeKeydownHandler.handleKeydown(event)
                return
            }

            const candidates = eventKeyCandidates(event)
            const bindings = application.host.commands
                .listKeybindings()
                .filter(
                    ({ keybinding, when }) =>
                        when?.() !== false && candidates.has(normalizeKeybinding(keybinding)),
                )
            if (bindings.length === 0) return

            const enabledBindings = await resolveHostKeybindings(bindings, event)
            if (!ready || writer.application !== application || enabledBindings.length === 0) return
            if (enabledBindings.length > 1) {
                const conflict = findKeybindingConflicts(enabledBindings)[0]
                const description = conflict
                    ? `${conflict[0]} (${conflict[1]
                          .map(({ extensionId, commandId }) => `${extensionId}:${commandId}`)
                          .join(", ")})`
                    : enabledBindings
                          .map(({ extensionId, commandId }) => `${extensionId}:${commandId}`)
                          .sort()
                          .join(", ")
                console.error(`[AppShell] Ignoring conflicting keybinding: ${description}`)
                return
            }

            const binding = enabledBindings[0]
            // Stop other listeners now that this binding has passed validation, but wait to
            // cancel the browser default until the command itself is accepted.
            event.stopImmediatePropagation()
            try {
                const payload = binding.keyboardPayload?.(event)
                await application.host.commands.execute(binding.commandId, payload, event)
                if (binding.preventDefault !== false) event.preventDefault()
                event.stopImmediatePropagation()
            } catch (error) {
                console.error(`[AppShell] Failed to execute ${binding.commandId}`, error)
            }
        }
        // Keep this listener in the bubbling phase. Contextual components such as the
        // library picker use a capture-phase listener for multi-key hints (for example,
        // `fa`); the global command dispatcher must not consume the second key first.
        window.addEventListener("keydown", handleKeydown)
        try {
            start()
        } catch {
            failMount()
        }
        return () => {
            window.removeEventListener("keydown", handleKeydown)
            subscription.dispose()
            void writer.stop()
        }
    })
</script>

<svelte:window onpagehide={handlePagehide} onpageshow={handlePageshow} />

{#if ready}
    <AppChrome>{@render children()}</AppChrome>
{:else}
    <WriterFeedback
        state={mountFailed && gateState !== "recovery-required" ? "failed" : gateState}
        retry={start}
        {reload}
    />
{/if}
