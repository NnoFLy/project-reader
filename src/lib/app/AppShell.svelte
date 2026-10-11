<script lang="ts">
    import { onMount } from "svelte"
    import AppChrome from "./AppChrome.svelte"
    import { createBuiltinApplication } from "./bootstrap"

    let { children } = $props()
    const application = createBuiltinApplication()

    onMount(() => {
        void application.start()
        return () => {
            void application.stop()
        }
    })
</script>

<AppChrome>{@render children()}</AppChrome>
