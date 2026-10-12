<script lang="ts">
    import * as m from "$lib/paraglide/messages"
    import Modal from "$lib/shared/ui/modal/Modal.svelte"
    import Button from "$lib/shared/ui/Button.svelte"
    import Input from "$lib/shared/ui/Input.svelte"
    import { relinkRequest } from "../state/relinkRequest.svelte"
    import { vfsStore } from "../state/libraryStore.svelte"
    import type { FileNode } from "../state/libraryStore.svelte"
    import { relinkLibraryNode } from "../commands/libraryRelinkExecution"
    import { commandsStore } from "../commands/commandsStore.svelte"
    import { defineCommands } from "../commands/commandsStore.svelte"
    import { useModalCommands } from "../commands/commandsStore.svelte"

    let fileInput = $state<HTMLInputElement | null>(null)
    let locateButton = $state<HTMLButtonElement | null>(null)
    const nodeId = $derived(relinkRequest.nodeId)
    const node = $derived(nodeId ? (vfsStore.nodes[nodeId] as FileNode) : null)

    function handleClose() {
        relinkRequest.cancel()
    }

    async function handleRelink(fileSource: File | FileSystemFileHandle) {
        if (!node) return
        await relinkLibraryNode(node.id, fileSource)
    }

    async function handleLocateClick() {
        if (typeof window.showOpenFilePicker === "function") {
            try {
                const [handle] = await window.showOpenFilePicker({
                    types: [
                        {
                            description: m.pdf_picker_description(),
                            accept: { "application/pdf": [".pdf"] },
                        },
                    ],
                    multiple: false,
                })
                if (handle) {
                    await handleRelink(handle)
                }
            } catch (err: any) {
                if (err.name !== "AbortError") {
                    console.error("showOpenFilePicker failed, falling back to input", err)
                    fileInput?.click()
                }
            }
        } else {
            fileInput?.click()
        }
    }

    function handleFileChange(event: Event) {
        const target = event.target as HTMLInputElement
        const files = target.files
        if (files && files.length > 0) {
            handleRelink(files[0])
        }
    }

    const activeNodeBeforeOpen = commandsStore.activeScope
    const modalCommands = defineCommands({
        "modal.cancel": {
            id: "modal.cancel",
            label: () => m.cancel(),
            category: "commands",
            keymap: ["escape", "ctrl+c", "ctrl+[", "q"],
            allowInInputs: true,
            dismissFocusedElement: true,
            run: handleClose,
        },
    })
    const commandsNode = useModalCommands(Object.values(modalCommands), activeNodeBeforeOpen)
</script>

<Modal
    variant="default"
    type="float"
    size="medium"
    placement="center"
    onClose={() => void commandsNode.execute("modal.cancel")}
    title={m.relink_modal_title()}
    closeLabel={m.close()}
    initialFocus={() => locateButton}
    draggable
>
    <div class="modal-form">
        <p class="description-text">
            {m.relink_modal_description({ name: node ? node.name : "" })}
        </p>
    </div>

    {#snippet footer()}
        <div class="modal-actions">
            <Button variant="close" onclick={() => void commandsNode.execute("modal.cancel")}>
                {m.cancel()}
            </Button>
            <Button bind:ref={locateButton} variant="brutalist" onclick={handleLocateClick}
                >{m.locate_file()}</Button
            >
        </div>
    {/snippet}
</Modal>

<Input
    unstyled
    bind:ref={fileInput}
    type="file"
    accept=".pdf"
    onchange={handleFileChange}
    style="display: none;"
/>

<style>
    .description-text {
        margin: 0;
        font-size: var(--font-size-md);
        line-height: 1.5;
        color: var(--text-color);
        font-weight: 600;
    }
</style>
