<script lang="ts">
    import { KeymapHelp } from "$lib/extensions/builtin/prompt"

    let { animations = true, onClose } = $props<{
        animations?: boolean
        onClose: () => void
    }>()
</script>

<KeymapHelp {animations} {onClose} />
