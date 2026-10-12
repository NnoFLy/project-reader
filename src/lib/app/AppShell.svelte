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
            executeCommand: async (commandId, payload) => {
                const command = application.host.contributions
                    .listCommands()
                    .find(({ id }) => id === commandId)
                if (!command) throw new Error(`Command is not registered: ${commandId}`)
                return command.execute(payload)
            },
        },
        get ready() {
            return ready
        },
    }
    setContext(APP_HOST_CONTEXT, hostContext)
    setContext("app-host-services", hostContext.services)

    onMount(() => {
        void application.start().then(() => (ready = true))
        return () => {
            void application.stop()
        }
    })
</script>

<AppChrome>{@render children()}</AppChrome>
