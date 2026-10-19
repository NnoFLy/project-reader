<script lang="ts">
    const libraryUI = useLibraryUI()
    import { useLibraryUI } from "../state/libraryUI.svelte"
    import { onMount } from "svelte"
    import * as m from "$lib/paraglide/messages"
    import Modal from "$lib/shared/ui/modal/Modal.svelte"
    import Button from "$lib/shared/ui/Button.svelte"
    import Input from "$lib/shared/ui/Input.svelte"
    import { vfsStore } from "../state/libraryStore.svelte"
    import { commandsStore } from "../commands/commandsStore.svelte"
    import { useModalCommands } from "../commands/commandsStore.svelte"
    import { defineCommands } from "../commands/commandsStore.svelte"
    import { updateLibraryBookMetadata } from "../commands/libraryMetadataExecution"

    interface Props {
        nodeId: string
    }

    const { nodeId }: Props = $props()

    const instanceId = $props.id()
    const titleInputId = `${instanceId}-title-input`
    const authorInputId = `${instanceId}-author-input`
    const pageInputId = `${instanceId}-page-input`
    const node = $derived(vfsStore.nodes[nodeId])

    let name = $state("")
    let author = $state("")
    let pageNumber = $state(1)

    let errors = $state<{
        name?: string[]
        author?: string[]
        pageNumber?: string[]
    }>({})

    let saving = $state(false)

    const modalCommands = defineCommands({
        "modal.confirm": {
            id: "modal.confirm",
            keymap: "enter",
            label: () => m.save(),
            category: "commands",
            allowInInputs: true,
            run: handleSave,
        },
        "modal.cancel": {
            id: "modal.cancel",
            keymap: ["escape", "ctrl+c", "ctrl+[", "q"],
            label: () => m.cancel(),
            category: "commands",
            allowInInputs: true,
            dismissFocusedElement: true,
            run: handleClose,
        },
    })

    const commandsNode = useModalCommands(Object.values(modalCommands))

    onMount(() => {
        if (node && node.type === "file") {
            name = node.name
            author = node.metadata.author || ""
            pageNumber = node.metadata.pageNumber || 1
        }
    })

    function validateForm() {
        let isValid = true
        const newErrors: typeof errors = {}

        if (!name.trim()) {
            newErrors.name = [m.title_required()]
            isValid = false
        }

        if (
            pageNumber === null ||
            pageNumber === undefined ||
            isNaN(pageNumber) ||
            pageNumber < 1
        ) {
            newErrors.pageNumber = [m.invalid_page_number()]
            isValid = false
        }

        errors = newErrors
        return isValid
    }

    async function handleSave() {
        if (saving || !validateForm()) return
        saving = true

        try {
            await updateLibraryBookMetadata({
                nodeId,
                name: name.trim(),
                author: author.trim() || null,
                pageNumber,
            })
        } finally {
            saving = false
        }
    }

    function handleClose() {
        if (!saving) libraryUI.closeMetadataEditor(nodeId)
    }
</script>

<Modal
    id={`library-metadata-${nodeId}`}
    onActivate={() => commandsStore.activate(commandsNode)}
    onDeactivate={() => commandsStore.deactivate(commandsNode)}
    variant="default"
    type="float"
    size="medium"
    placement="center"
    onClose={() => void commandsNode.execute("modal.cancel")}
    title={m.edit_book_metadata()}
    closeLabel={m.close()}
    initialFocus={() => document.getElementById(titleInputId)}
    draggable
>
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
        class="modal-form"
        onkeydown={(e) => {
            if (e.key === "Enter") {
                e.preventDefault()
                e.stopPropagation()
                void commandsNode.execute("modal.confirm")
            }
        }}
    >
        <Input
            id={titleInputId}
            disabled={saving}
            placeholder={m.title()}
            label={m.title()}
            bind:value={name}
            errors={errors.name}
        />
        <Input
            id={authorInputId}
            disabled={saving}
            placeholder={m.author()}
            label={m.author()}
            bind:value={author}
            errors={errors.author}
        />
        <Input
            id={pageInputId}
            disabled={saving}
            type="number"
            min="1"
            placeholder={m.current_page()}
            label={m.current_page()}
            bind:value={pageNumber}
            errors={errors.pageNumber}
        />
    </div>

    {#snippet footer()}
        <div class="modal-actions">
            <Button
                variant="ghost"
                disabled={saving}
                onclick={() => void commandsNode.execute("modal.cancel")}>{m.cancel()}</Button
            >
            <Button
                variant="brutalist"
                disabled={saving}
                onclick={() => void commandsNode.execute("modal.confirm")}>{m.save()}</Button
            >
        </div>
    {/snippet}
</Modal>
