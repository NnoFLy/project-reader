<script lang="ts">
    import { onMount, setContext } from "svelte"
    import AppChrome from "./AppChrome.svelte"
    import { createBuiltinApplication } from "./bootstrap"
    import { APP_HOST_CONTEXT, type AppHostContext } from "./hostContext"

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

    function normalizeKeybinding(keybinding: string): string {
        const isMac =
            typeof navigator !== "undefined" && /Mac|iPod|iPhone|iPad/i.test(navigator.platform)
        return keybinding
            .trim()
            .toLowerCase()
            .split("+")
            .map((part) => (part === "mod" ? (isMac ? "meta" : "ctrl") : part.trim()))
            .filter(Boolean)
            .sort()
            .join("+")
    }

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
            const binding = application.host.commands
                .listKeybindings()
                .find(
                    ({ keybinding, when }) =>
                        when?.() !== false && candidates.has(normalizeKeybinding(keybinding)),
                )
            if (!binding) return
            event.preventDefault()
            void application.host.commands.execute(binding.commandId).catch((error) => {
                console.error(`[AppShell] Failed to execute ${binding.commandId}`, error)
            })
        }
        window.addEventListener("keydown", handleKeydown)
        void application.start().then(() => (ready = true))
        return () => {
            window.removeEventListener("keydown", handleKeydown)
            void application.stop()
        }
    })
</script>

<AppChrome>{@render children()}</AppChrome>
