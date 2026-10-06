<script lang="ts">
    const libraryUI = useLibraryUI()
    import { useLibraryUI } from "../state/libraryUI.svelte"
    import { onMount, tick } from "svelte"
    import * as m from "$lib/paraglide/messages"
    import Modal from "$lib/shared/ui/modal/Modal.svelte"
    import Button from "$lib/shared/ui/Button.svelte"
    import Input from "$lib/shared/ui/Input.svelte"
    import { commandsStore } from "$lib/modules/commands"
    import { useModalCommands } from "$lib/modules/commands"
    import { defineCommands } from "$lib/modules/commands"

    interface Props {
        onCreate?: (name: string) => void | Promise<void>
    }

    const { onCreate }: Props = $props()

    let folderName = $state("")
    let errors = $state<string[]>([])

    const activeNodeBeforeOpen = commandsStore.activeScope

    const modalCommands = defineCommands({
        "modal.confirm": {
            id: "modal.confirm",
            keymap: "enter",
            label: () => m.create(),
            category: "commands",
            allowInInputs: true,
            run: handleCreate,
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

    const commandsNode = useModalCommands(Object.values(modalCommands), activeNodeBeforeOpen)

    onMount(async () => {
        folderName = ""
        errors = []

        // Focus the input when modal opens
        await tick()
        const input = document.getElementById("folder-name-input") as HTMLInputElement | null
        if (input) {
            input.focus()
            input.select()
        }
    })

    function validateInput() {
        if (folderName.length <= 0) {
            errors.push(m.folder_name_required())
        }

        if (errors.length > 0) {
            return false
        }

        errors = []
        return true
    }

    async function handleCreate() {
        if (folderName.length <= 0) {
            errors = [m.folder_name_required()]
            return
        }

        if (document.activeElement instanceof HTMLElement) {
            document.activeElement.blur()
        }

        errors = []
        libraryUI.isNewFolderModalOpen = false

        if (onCreate) {
            await onCreate(folderName)
        }
    }
    function handleClose() {
        if (document.activeElement instanceof HTMLElement) {
            document.activeElement.blur()
        }
        libraryUI.isNewFolderModalOpen = false
    }
</script>

<Modal
    variant="default"
    type="float"
    size="medium"
    placement="center"
    onClose={() => handleClose()}
    title={m.new_folder()}
    closeLabel={m.close()}
    initialFocus={() => document.getElementById("folder-name-input")}
    draggable
>
    <div class="modal-form">
        <Input
            id="folder-name-input"
            placeholder={m.folder_name_placeholder()}
            label={m.folder_name()}
            bind:value={folderName}
            onfocusout={validateInput}
            onkeydown={(e) => {
                if (e.key === "Enter") {
                    e.preventDefault()
                    e.stopPropagation()
                    void commandsNode.execute("modal.confirm")
                }
            }}
            {errors}
        />
    </div>

    {#snippet footer()}
        <div class="modal-actions">
            <Button variant="ghost" onclick={() => void commandsNode.execute("modal.cancel")}
                >{m.cancel()}</Button
            >
            <Button variant="brutalist" onclick={() => void commandsNode.execute("modal.confirm")}
                >{m.create()}</Button
            >
        </div>
    {/snippet}
</Modal>
