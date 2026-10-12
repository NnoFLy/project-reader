<script lang="ts">
    const libraryUI = useLibraryUI()
    import { useLibraryUI } from "../state/libraryUI.svelte"
    import type { VFSNode } from "$lib/modules/documents"
    import { onMount } from "svelte"

    interface Props {
        currentNodes: VFSNode[]
        currentHints: string[]
        keyBuffer: string
        onSelect: (node: VFSNode) => void
    }

    let { currentNodes, currentHints, keyBuffer = $bindable(), onSelect }: Props = $props()

    function closePicker() {
        keyBuffer = ""
        libraryUI.isPickingMode = false
    }

    function handleKeydown(event: KeyboardEvent) {
        const key = event.key.toLowerCase()
        const isCloseKey =
            key === "escape" ||
            (event.ctrlKey && (key === "c" || key === "[")) ||
            (!event.ctrlKey && !event.metaKey && !event.altKey && key === "q")
        if (isCloseKey) {
            event.preventDefault()
            event.stopImmediatePropagation()
            closePicker()
            return
        }

        if (key === "backspace" || (event.ctrlKey && key === "h")) {
            event.preventDefault()
            event.stopImmediatePropagation()
            keyBuffer = keyBuffer.slice(0, -1)
            return
        }
        if (event.ctrlKey || event.metaKey || event.altKey || key.length !== 1) return

        const nextBuffer = keyBuffer + key
        const matchIndex = currentHints.findIndex((hint) => hint === nextBuffer)
        const hasPrefix = currentHints.some((hint) => hint.startsWith(nextBuffer))
        event.preventDefault()
        event.stopImmediatePropagation()
        if (!hasPrefix) return

        if (matchIndex >= 0 && currentNodes[matchIndex]) {
            onSelect(currentNodes[matchIndex])
            keyBuffer = ""
        } else {
            keyBuffer = nextBuffer
        }
    }

    onMount(() => {
        window.addEventListener("keydown", handleKeydown, { capture: true })
        return () => window.removeEventListener("keydown", handleKeydown, { capture: true })
    })
</script>
