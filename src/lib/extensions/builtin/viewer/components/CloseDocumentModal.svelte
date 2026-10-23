<script lang="ts">
    import * as m from "$lib/paraglide/messages"
    import Modal from "$lib/shared/ui/modal/Modal.svelte"
    import Button from "$lib/shared/ui/Button.svelte"
    import { commandsStore, defineCommands, useModalCommands } from "$lib/core/commands"
    import type { ViewerCloseController } from "../viewerClose.svelte"

    let { closing }: { closing: ViewerCloseController } = $props()
    const scope = useModalCommands(
        Object.values(
            defineCommands({
                "modal.cancel": {
                    id: "modal.cancel",
                    label: () => m.cancel(),
                    category: "commands",
                    keymap: "escape",
                    allowInInputs: true,
                    run: () => closing.choose("cancel"),
                },
            }),
        ),
    )
</script>

<Modal
    id="reading-close-decision"
    onActivate={() => commandsStore.activate(scope)}
    onDeactivate={() => commandsStore.deactivate(scope)}
    title={m.close_drafts_title()}
    description={m.close_drafts_message()}
    size="small"
    placement="center"
    closeOnBackdrop={false}
    closeOnEscape={!closing.busy}
    showCloseButton={false}
    initialFocus={() => document.getElementById("reading-close-cancel")}
    onClose={() => void closing.choose("cancel")}
>
    <p>{m.close_drafts_message()}</p>
    {#if closing.failed}
        <p role="alert">{m.reading_annotations_error()}</p>
    {/if}
    {#snippet footer()}
        <div class="close-actions">
            <Button disabled={closing.busy} onclick={() => void closing.choose("save")}>
                {m.save()}
            </Button>
            <Button disabled={closing.busy} onclick={() => void closing.choose("discard")}>
                {m.discard()}
            </Button>
            <Button
                id="reading-close-cancel"
                disabled={closing.busy}
                onclick={() => void closing.choose("cancel")}
            >
                {m.cancel()}
            </Button>
        </div>
    {/snippet}
</Modal>

<style>
    p {
        padding-inline: 20px;
        overflow-wrap: anywhere;
    }
    .close-actions {
        display: flex;
        flex-wrap: wrap;
        justify-content: flex-end;
        gap: 12px;
    }
</style>
