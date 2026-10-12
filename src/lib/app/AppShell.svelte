<script lang="ts">
    import { onMount, setContext } from "svelte"
    import AppChrome from "./AppChrome.svelte"
    import { createBuiltinApplication } from "./bootstrap"
    import { APP_HOST_CONTEXT, type AppHostContext } from "./hostContext"
    import { findKeybindingConflicts, normalizeKeybinding } from "$lib/core/commands"

    let { children } = $props()
    const application = createBuiltinApplication()
    let ready = $state(false)
    const hostContext: AppHostContext = {
        application,
        services: {
            executeCommand: (commandId, payload) =>
                application.host.commands.execute(commandId, payload),
        },
        get ready() {
            return ready
        },
    }
    setContext(APP_HOST_CONTEXT, hostContext)
    setContext("app-host-services", hostContext.services)

    function eventKeyCandidates(event: KeyboardEvent): Set<string> {
        const modifiers = [
            event.ctrlKey ? "ctrl" : "",
            event.metaKey ? "meta" : "",
            event.altKey ? "alt" : "",
            event.shiftKey ? "shift" : "",
        ].filter(Boolean)
        const key = event.key === " " ? "space" : event.key.toLowerCase()
        const candidates = new Set([normalizeKeybinding([...modifiers, key].join("+"))])
        if (event.code) {
            const codeKey = event.code.replace(/^(Key|Digit)/, "").toLowerCase()
            candidates.add(normalizeKeybinding([...modifiers, codeKey].join("+")))
        }
        return candidates
    }

    onMount(() => {
        const handleKeydown = (event: KeyboardEvent) => {
            if (!ready) return
            const candidates = eventKeyCandidates(event)
            const bindings = application.host.commands
                .listKeybindings()
                .filter(
                    ({ keybinding, when }) =>
                        when?.() !== false && candidates.has(normalizeKeybinding(keybinding)),
                )
            if (bindings.length === 0) return
            if (bindings.length > 1) {
                const conflict = findKeybindingConflicts(bindings)[0]
                const description = conflict
                    ? `${conflict[0]} (${conflict[1]
                          .map(({ extensionId, commandId }) => `${extensionId}:${commandId}`)
                          .join(", ")})`
                    : bindings
                          .map(({ extensionId, commandId }) => `${extensionId}:${commandId}`)
                          .sort()
                          .join(", ")
                console.error(`[AppShell] Ignoring conflicting keybinding: ${description}`)
                event.preventDefault()
                event.stopImmediatePropagation()
                return
            }
            const binding = bindings[0]
            // Host dispatch is capture-phase so a local viewer/window handler cannot execute the
            // same command without the host payload, enabled, and permission checks.
            event.preventDefault()
            event.stopImmediatePropagation()
            void application.host.commands.execute(binding.commandId).catch((error) => {
                console.error(`[AppShell] Failed to execute ${binding.commandId}`, error)
            })
        }
        window.addEventListener("keydown", handleKeydown, { capture: true })
        void application.start().then(() => (ready = true))
        return () => {
            window.removeEventListener("keydown", handleKeydown, { capture: true })
            void application.stop()
        }
    })
</script>

<AppChrome>{@render children()}</AppChrome>
