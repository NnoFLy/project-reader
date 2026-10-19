<script lang="ts">
    import PlusIcon from "$lib/shared/icons/PlusIcon.svelte"
    import BookOpenIcon from "$lib/shared/icons/BookOpenIcon.svelte"
    import Spinner from "$lib/shared/ui/Spinner.svelte"
    import Input from "$lib/shared/ui/Input.svelte"
    import Button from "$lib/shared/ui/Button.svelte"
    import * as m from "$lib/paraglide/messages"
    import { vfsStore } from "../state/libraryStore.svelte"
    import { getLibraryErrorDiagnostic } from "../state/libraryDiagnostics"
    import { useCommands } from "../commands/commandsStore.svelte"
    import { defineCommands } from "../commands/commandsStore.svelte"
    import { publishNotification } from "../state/libraryNotifications"
    import type { ImportInput } from "../state/libraryStore.svelte"

    interface Props {
        onimport?: (book: { url: string; name: string }) => void
        variant?: "full" | "card" | "action"
        class?: string
    }

    let { onimport, variant = "full", class: className = "" }: Props = $props()

    let fileInput = $state<HTMLInputElement | null>(null)
    let dragCount = $state(0)
    let isDragging = $derived(dragCount > 0)
    let isSubmitting = $state(false)
    let isPicking = $state(false)
    let isImporting = $derived(isSubmitting || isPicking)

    async function processInputs(inputs: ImportInput[]) {
        if (isSubmitting || inputs.length === 0) return
        isSubmitting = true
        try {
            await vfsStore.importFiles(inputs, vfsStore.currentFolderId, {
                onImported: async ({ id, name }) => {
                    if (!onimport) return
                    const url = await vfsStore.getFileUrl(id)
                    onimport({ url, name })
                },
                onFailure: ({ name }, phase) => {
                    const metadataFailure = phase === "metadata"
                    publishNotification({
                        line1: metadataFailure
                            ? m.book_metadata_failed({ name })
                            : m.book_import_failed({ name }),
                        line2: name,
                    })
                },
            })
        } catch (error) {
            console.error("Failed to complete import batch:", getLibraryErrorDiagnostic(error))
        } finally {
            isSubmitting = false
        }
    }

    function processFiles(files: FileList | File[]) {
        void processInputs(Array.from(files, (file) => ({ name: file.name, source: file })))
    }

    function handleFileChange(event: Event) {
        const target = event.target as HTMLInputElement
        const fileList = target.files
        if (fileList && fileList.length > 0) processFiles(fileList)
        target.value = ""
    }

    async function handleImportClick(event?: MouseEvent | null) {
        if (event) event.stopPropagation()
        if (isPicking) return
        if (typeof window.showOpenFilePicker === "function") {
            isPicking = true
            try {
                const handles = await window.showOpenFilePicker({
                    types: [
                        {
                            description: m.pdf_picker_description(),
                            accept: { "application/pdf": [".pdf"] },
                        },
                    ],
                    multiple: true,
                })

                await processInputs(
                    handles.map((handle) => ({ name: handle.name, source: handle })),
                )
            } catch (err: unknown) {
                if (!(err instanceof DOMException && err.name === "AbortError")) {
                    console.error(
                        "showOpenFilePicker failed, falling back to standard input",
                        getLibraryErrorDiagnostic(err, "File picker unavailable"),
                    )
                    fileInput?.click()
                }
            } finally {
                isPicking = false
            }
        } else {
            fileInput?.click()
        }
    }

    function handleDragEnter(event: DragEvent) {
        event.preventDefault()
        dragCount++
    }

    function handleDragLeave(event: DragEvent) {
        event.preventDefault()
        dragCount = Math.max(0, dragCount - 1)
    }

    function handleDragOver(event: DragEvent) {
        event.preventDefault()
    }

    function handleDrop(event: DragEvent) {
        event.preventDefault()
        dragCount = 0

        const files = event.dataTransfer?.files
        if (files && files.length > 0) {
            processFiles(files)
        }
    }

    const importerCommands = defineCommands({
        "library.books.import": {
            id: "library.books.import",
            keymap: "a",
            label: () => m.keymap_import_book(),
            englishLabel: () => m.keymap_import_book({}, { locale: "en" }),
            category: "commands",
            disabled: () => isPicking,
            run: async () => {
                await handleImportClick()
            },
        },
    })

    const commandsNode = useCommands([importerCommands["library.books.import"]], undefined, {
        registerOnParent: true,
    })
</script>

{#if variant === "action"}
    <Button
        variant="brutalist"
        type="button"
        class={`import-action ${className}`}
        disabled={isImporting}
        onclick={(event) => {
            event.stopPropagation()
            void commandsNode.execute("library.books.import")
        }}
    >
        {#if isImporting}
            <Spinner variant="classic" size="sm" />
            <span>{m.importing_book()}</span>
        {:else}
            <PlusIcon />
            <span>{m.import_file()}</span>
        {/if}
    </Button>
{:else if variant === "card"}
    <button
        type="button"
        class={`card card-importer ${className}`}
        class:drag-active={isDragging}
        class:importing={isImporting}
        data-id="book-importer"
        disabled={isImporting}
        onclick={(event) => {
            event.stopPropagation()
            void commandsNode.execute("library.books.import")
        }}
        ondragenter={handleDragEnter}
        ondragleave={handleDragLeave}
        ondragover={handleDragOver}
        ondrop={handleDrop}
    >
        <div class="card-cover-container">
            <div class="card-icon" aria-hidden="true">
                {#if isImporting}
                    <Spinner variant="classic" size="md" />
                {:else}
                    <PlusIcon />
                {/if}
            </div>
        </div>
        <div class="card-metadata">
            <p class="card-title">
                {#if isImporting}
                    {m.importing_book()}
                {:else}
                    {m.import_file()}
                {/if}
            </p>
            <p class="card-author">&nbsp;</p>
        </div>
    </button>
{:else}
    <div
        class="reader-card"
        class:drag-active={isDragging}
        class:importing={isImporting}
        role="region"
        aria-label={m.file_drop_zone()}
        ondragenter={handleDragEnter}
        ondragleave={handleDragLeave}
        ondragover={handleDragOver}
        ondrop={handleDrop}
    >
        <div class="upload-zone">
            <div class="dashed-border">
                <div class="upload-icon-wrapper" aria-hidden="true">
                    {#if isImporting}
                        <Spinner
                            variant="classic"
                            size="lg"
                            style="--border-color: color-mix(in srgb, var(--text-color) 28%, transparent); --danger-active-color: var(--text-color);"
                        />
                    {:else}
                        <BookOpenIcon width="44" height="44" />
                    {/if}
                </div>
                <h3>
                    {#if isImporting}
                        {m.importing_book()}
                    {:else}
                        {m.import_file()}
                    {/if}
                </h3>
                <div class="empty-copy">
                    <p>{m.open_pdfs()}</p>
                    <p>{m.files_stay_local()}</p>
                    <p class="drag-hint">{m.drag_drop_hint()}</p>
                </div>
                <Button
                    variant="brutalist"
                    type="button"
                    class="upload-btn"
                    disabled={isImporting}
                    onclick={(event) => {
                        event.stopPropagation()
                        void commandsNode.execute("library.books.import")
                    }}
                >
                    {#if isImporting}
                        <Spinner
                            variant="classic"
                            size="sm"
                            style="--border-color: color-mix(in srgb, var(--primary-text-color) 28%, transparent); --danger-active-color: var(--primary-text-color);"
                        />
                        <span>{m.importing_book()}</span>
                    {:else}
                        {m.choose_file()}
                    {/if}
                </Button>
            </div>
        </div>
    </div>
{/if}

<Input
    unstyled
    bind:ref={fileInput}
    type="file"
    accept=".pdf"
    multiple
    onchange={handleFileChange}
    style="display: none;"
/>

<style>
    :global(.button.import-action),
    .dashed-border :global(.upload-btn) {
        background: var(--primary-color);
        color: var(--primary-text-color);
        border-color: transparent;
        font-size: var(--font-size-base);
        font-weight: 500;
        min-height: 40px;
        padding-inline: 20px;
    }
    :global(.button.import-action:hover:not(:disabled)),
    .dashed-border :global(.upload-btn:hover:not(:disabled)) {
        background: var(--primary-color);
        opacity: 0.88;
    }
    .reader-card {
        background: var(--surface-color);
        border-radius: var(--radius-lg);
        overflow: hidden;
    }
    .upload-zone {
        padding: 32px 24px;
    }
    .dashed-border {
        /* One content column: equal outer space rather than an empty grid cell. */
        min-height: 360px;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        text-align: center;
    }
    .upload-icon-wrapper {
        display: flex;
        color: var(--faded-text-color);
        margin-bottom: 24px;
    }
    h3 {
        margin: 0 0 12px;
        font-size: var(--font-size-2xl);
        font-weight: 500;
        letter-spacing: -0.02em;
    }
    .empty-copy {
        display: grid;
        gap: 4px;
    }
    .empty-copy p {
        margin: 0;
        color: var(--faded-text-color);
        font-size: var(--font-size-base);
        line-height: 1.6;
    }
    .dashed-border :global(.upload-btn) {
        margin-top: 24px;
    }
    .drag-hint {
        margin-top: 8px !important;
    }
    .card {
        display: flex;
        flex-direction: column;
        width: 100%;
        padding: 0;
        background: var(--surface-color);
        color: var(--text-color);
        border: 1px dashed var(--color-control-border);
        border-radius: var(--radius-md);
        cursor: pointer;
        font-family: inherit;
        text-align: left;
    }
    .card-cover-container {
        display: grid;
        place-items: center;
        width: 100%;
        aspect-ratio: 2 / 3;
    }
    .card-icon {
        color: var(--faded-text-color);
    }
    .card-icon :global(svg) {
        width: 36px;
        height: 36px;
    }
    .card-metadata {
        padding: 16px;
    }
    .card-title {
        margin: 0;
        font-size: var(--font-size-base);
        font-weight: 500;
    }
    .card-author {
        margin: 4px 0 0;
        font-size: var(--font-size-sm);
    }
    .card:focus-visible {
        outline: 2px solid var(--focus-color);
        outline-offset: 3px;
    }
    .card:disabled {
        cursor: wait;
        color: var(--faded-text-color);
    }
    .reader-card.importing {
        cursor: wait;
    }
    .reader-card.drag-active,
    .card.drag-active {
        outline: 2px solid var(--focus-color);
        outline-offset: -2px;
        background: var(--surface-hover-color);
    }
    @media (hover: none), (pointer: coarse) {
        .drag-hint {
            display: none;
        }
    }
    @media (--mobile-width) {
        .upload-zone {
            padding: 24px 16px;
        }
        .dashed-border {
            min-height: 320px;
        }
        .card-metadata {
            padding: 12px;
        }
        .dashed-border :global(.upload-btn) {
            min-height: 44px;
        }
    }
</style>
