<script lang="ts">
    import { onMount, tick } from "svelte"
    import * as m from "$lib/paraglide/messages"
    import { commandsStore, defineCommands, useModalCommands } from "$lib/modules/commands"
    import { FolderNameError, vfsStore } from "$lib/modules/documents"
    import Button from "$lib/shared/ui/Button.svelte"
    import Input from "$lib/shared/ui/Input.svelte"
    import Modal from "$lib/shared/ui/modal/Modal.svelte"
    import { renameLibraryFolder } from "../commands/libraryCommandExecution"
    import { useLibraryUI } from "../state/libraryUI.svelte"

    interface Props {
        nodeId: string
    }

    const { nodeId }: Props = $props()
    const libraryUI = useLibraryUI()
    const node = $derived(vfsStore.nodes[nodeId])
    let name = $state("")
    let errors = $state<string[]>([])
    let submitting = $state(false)
    const activeNodeBeforeOpen = commandsStore.activeScope

    function close() {
        if (submitting) return
        libraryUI.isRenameFolderModalOpen = false
        libraryUI.folderToRenameId = null
    }

    function errorMessage(error: unknown): string {
        if (error instanceof FolderNameError) {
            if (error.code === "empty") return m.folder_name_required()
            if (error.code === "slash") return m.folder_name_slash()
            return m.folder_name_duplicate()
        }
        return m.folder_rename_failed()
    }

    async function save() {
        if (submitting) return
        submitting = true
        errors = []
        try {
            await renameLibraryFolder(nodeId, name)
        } catch (error) {
            errors = [errorMessage(error)]
        } finally {
            submitting = false
        }
    }

    const modalCommands = defineCommands({
        "modal.confirm": {
            id: "modal.confirm",
            keymap: "enter",
            label: () => m.save(),
            category: "commands",
            allowInInputs: true,
            run: save,
        },
        "modal.cancel": {
            id: "modal.cancel",
            keymap: ["escape", "ctrl+c", "ctrl+[", "q"],
            label: () => m.cancel(),
            category: "commands",
            allowInInputs: true,
            dismissFocusedElement: true,
            run: close,
        },
    })
    const commandsNode = useModalCommands(Object.values(modalCommands), activeNodeBeforeOpen)

    onMount(async () => {
        if (node?.type === "folder") name = node.name
        await tick()
        const input = document.getElementById("rename-folder-input") as HTMLInputElement | null
        input?.focus()
        input?.select()
    })
</script>

<Modal
    variant="default"
    type="float"
    size="medium"
    placement="center"
    onClose={() => void commandsNode.execute("modal.cancel")}
    title={m.rename_folder()}
    closeLabel={m.close()}
    initialFocus={() => document.getElementById("rename-folder-input")}
    draggable
>
    <div class="modal-form">
        <Input
            id="rename-folder-input"
            placeholder={m.folder_name_placeholder()}
            label={m.folder_name()}
            bind:value={name}
            {errors}
            disabled={submitting}
            onkeydown={(event) => {
                if (event.key === "Enter") {
                    event.preventDefault()
                    event.stopPropagation()
                    void commandsNode.execute("modal.confirm")
                }
            }}
        />
    </div>

    {#snippet footer()}
        <div class="modal-actions">
            <Button
                variant="ghost"
                disabled={submitting}
                onclick={() => void commandsNode.execute("modal.cancel")}>{m.cancel()}</Button
            >
            <Button
                variant="brutalist"
                disabled={submitting}
                onclick={() => void commandsNode.execute("modal.confirm")}>{m.save()}</Button
            >
        </div>
    {/snippet}
</Modal>
