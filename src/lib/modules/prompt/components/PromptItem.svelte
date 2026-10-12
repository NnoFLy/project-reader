<script lang="ts">
    import { PromptItemComponent } from "$lib/extensions/builtin/prompt"
    import type { PromptItem as PromptItemData } from "$lib/extensions/builtin/prompt"

    let {
        id,
        item,
        isSelected,
        animationDelay = 0,
        onclick,
    } = $props<{
        id: string
        item: PromptItemData<unknown>
        isSelected: boolean
        animationDelay?: number
        onclick: () => void
    }>()
</script>

<PromptItemComponent {id} {item} {isSelected} {animationDelay} {onclick} />
