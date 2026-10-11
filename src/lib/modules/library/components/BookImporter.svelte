<script lang="ts">
    import PlusIcon from "$lib/shared/icons/PlusIcon.svelte"
    import Spinner from "$lib/shared/ui/Spinner.svelte"
    import Input from "$lib/shared/ui/Input.svelte"
    import * as m from "$lib/paraglide/messages"
    import { vfsStore } from "$lib/modules/documents"
    import { useCommands } from "$lib/modules/commands"
    import { defineCommands } from "$lib/modules/commands"
    import { publishNotification } from "$lib/modules/notifications"
    import type { ImportInput } from "$lib/modules/documents"

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
            console.error("Failed to complete import batch:", error)
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
                    console.error("showOpenFilePicker failed, falling back to standard input", err)
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
    <button
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
    </button>
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
                            style="--border-color: color-mix(in srgb, var(--primary-text-color) 28%, transparent); --danger-active-color: var(--primary-text-color);"
                        />
                    {:else}
                        <PlusIcon width="48" height="48" />
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
                <button
                    type="button"
                    class="btn upload-btn"
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
                </button>
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
    .import-action {
        min-height: var(--control-height-regular);
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 8px;
        padding: 8px 16px;
        border: var(--border-elevated) solid var(--border-color);
        background: var(--primary-color);
        color: var(--primary-text-color);
        box-shadow: var(--shadow-elevated);
        font-family: var(--ui-font);
        font-size: var(--font-size-base);
        font-weight: 800;
        cursor: pointer;
        transition:
            transform 140ms cubic-bezier(0.4, 0, 0.2, 1),
            box-shadow 140ms cubic-bezier(0.4, 0, 0.2, 1);
    }

    @media (hover: hover) and (pointer: fine) {
        .import-action:hover:not(:disabled):not(:active) {
            transform: translate(-1px, -1px);
            box-shadow: 6px 6px 0 var(--shadow-color);
        }

        .import-action:hover:not(:disabled):not(:active) :global(svg) {
            transform: translateY(-1px) rotate(8deg);
        }
    }

    .import-action:active:not(:disabled) {
        transform: translate(2px, 2px);
        box-shadow: 1px 1px 0 var(--shadow-color);
    }

    .import-action:focus-visible {
        outline: none;
        box-shadow: var(--shadow-elevated), var(--focus-ring);
    }

    .import-action:disabled {
        cursor: wait;
        opacity: 0.7;
    }

    .import-action :global(svg) {
        width: 18px;
        height: 18px;
        transition: transform 140ms cubic-bezier(0.4, 0, 0.2, 1);
    }

    .reader-card {
        grid-column: 1 / -1;
        background: var(--surface-color);
        border: 3px solid var(--border-color);
        box-shadow: var(--shadow-elevated);
        margin-top: 8px;
        transition:
            transform 0.15s ease,
            box-shadow 0.15s ease;
        overflow: hidden;
    }

    /* Neo-brutalist button style */
    .btn {
        background: var(--surface-color);
        border: 2px solid var(--border-color);
        font-family: inherit;
        font-size: var(--font-size-md);
        font-weight: 800;
        text-transform: uppercase;
        color: var(--text-color);
        padding: 8px 16px;
        cursor: pointer;
        box-shadow: var(--shadow-elevated);
        transition:
            background-color 0.1s cubic-bezier(0.4, 0, 0.2, 1),
            border-color 0.1s cubic-bezier(0.4, 0, 0.2, 1),
            box-shadow 0.1s cubic-bezier(0.4, 0, 0.2, 1),
            color 0.1s cubic-bezier(0.4, 0, 0.2, 1),
            transform 0.1s cubic-bezier(0.4, 0, 0.2, 1);
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 6px;
        user-select: none;
    }

    @media (hover: hover) {
        .btn:hover:not(:disabled) {
            transform: translate(-1px, -1px);
            box-shadow: 4px 4px 0 var(--shadow-color);
            background: var(--surface-hover-color);
        }
    }

    .btn:active:not(:disabled) {
        transform: translate(2px, 2px);
        box-shadow: 1px 1px 0 var(--shadow-color);
    }

    .btn:disabled {
        opacity: 0.5;
        cursor: not-allowed;
        box-shadow: 1px 1px 0 var(--shadow-color);
        transform: translate(1px, 1px);
    }

    /* Upload Screen */
    .upload-zone {
        padding: clamp(20px, 5vw, 36px);
        text-align: center;
        background: var(--surface-color);
    }

    .dashed-border {
        border: 2px dashed var(--border-color);
        padding: clamp(20px, 4vw, 32px) 20px;
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 16px;
    }

    .upload-icon-wrapper {
        background: var(--primary-color);
        border: 2.5px solid var(--border-color);
        padding: 16px;
        border-radius: var(--radius-full);
        display: inline-flex;
        box-shadow: 3px 3px 0 var(--shadow-color);
        color: var(--primary-text-color);
        margin-bottom: 8px;
    }

    .dashed-border h3 {
        margin: 0;
        font-size: var(--font-size-3xl);
        font-weight: 900;
        letter-spacing: -0.5px;
        color: var(--text-color);
    }

    .empty-copy {
        display: grid;
        gap: 4px;
    }

    .dashed-border p {
        margin: 0;
        font-size: var(--font-size-md);
        color: var(--text-color);
        opacity: 0.8;
        max-width: 320px;
        line-height: 1.5;
        font-weight: bold;
    }

    .upload-btn {
        margin-top: 8px;
        background: var(--primary-color);
        color: var(--primary-text-color);
        border-color: var(--border-color);
    }

    @media (hover: hover) {
        .upload-btn:hover {
            background: var(--primary-color);
            opacity: 0.9;
        }
    }

    @media (hover: none), (pointer: coarse) {
        .drag-hint {
            display: none;
        }
    }

    /* Card variant styles */
    .card {
        background: var(--surface-color);
        position: relative;
        border: 2px solid var(--border-color);
        box-shadow: var(--shadow-elevated);
        transition:
            background-color 0.15s cubic-bezier(0.4, 0, 0.2, 1),
            border-color 0.15s cubic-bezier(0.4, 0, 0.2, 1),
            box-shadow 0.15s cubic-bezier(0.4, 0, 0.2, 1),
            transform 0.15s cubic-bezier(0.4, 0, 0.2, 1);
        cursor: pointer;
        font-family: inherit;
        text-align: left;
        color: inherit;
        user-select: none;
        box-sizing: border-box;
        display: flex;
        flex-direction: column;
        align-items: stretch;
        justify-content: flex-start;
        padding: 0;
    }

    @media (hover: hover) {
        .card:hover:not(:disabled) {
            transform: translate(-4px, -4px);
            box-shadow: 8px 8px 0 var(--shadow-color);
            background-color: var(--surface-hover-color);
        }
    }

    .card:focus-visible:not(:disabled) {
        transform: translate(-4px, -4px);
        box-shadow: 8px 8px 0 var(--shadow-color);
        background-color: var(--surface-hover-color);
        outline: none;
    }

    .card:active:not(:disabled) {
        transform: translate(2px, 2px);
        box-shadow: 2px 2px 0 var(--shadow-color);
    }

    .card-cover-container {
        position: relative;
        width: 100%;
        aspect-ratio: 2/3;
        background: var(--bg-color);
        border-bottom: 2px solid var(--border-color);
        overflow: hidden;
        display: flex;
        align-items: center;
        justify-content: center;
        box-sizing: border-box;
    }

    .card-icon {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 100%;
        height: 100%;
        color: var(--text-color);
    }

    .card-icon :global(svg) {
        width: 48px;
        height: 48px;
        stroke-width: 2;
    }

    .card-metadata {
        width: 100%;
        display: flex;
        flex-direction: column;
        gap: 4px;
        padding: 12px;
        box-sizing: border-box;
        text-align: left;
    }

    .card-title {
        font-size: var(--font-size-md);
        font-weight: 800;
        text-transform: uppercase;
        margin: 0;
        text-align: left;
        width: 100%;
        word-wrap: break-word;
        color: var(--text-color);
        display: -webkit-box;
        -webkit-line-clamp: 2;
        line-clamp: 2;
        -webkit-box-orient: vertical;
        overflow: hidden;
        line-height: 1.3;
    }

    .card-author {
        font-size: var(--font-size-2xs);
        font-weight: 600;
        text-transform: uppercase;
        margin: 0;
        text-align: left;
        width: 100%;
        word-wrap: break-word;
        color: var(--text-color);
        opacity: 0.7;
        display: -webkit-box;
        -webkit-line-clamp: 1;
        line-clamp: 1;
        -webkit-box-orient: vertical;
        overflow: hidden;
        line-height: 1.2;
    }

    .card-importer {
        background-color: transparent;
    }

    @media (--mobile-width) {
        .card-metadata {
            padding: 8px;
            gap: 2px;
        }

        .card-title {
            font-size: var(--font-size-sm);
        }

        .card-author {
            font-size: var(--font-size-2xs);
        }

        .card-icon :global(svg) {
            width: 36px;
            height: 36px;
        }

        .upload-zone {
            padding: 24px 16px;
        }

        .dashed-border {
            padding: 24px 12px;
            gap: 12px;
        }

        .dashed-border h3 {
            font-size: var(--font-size-2xl);
        }

        .dashed-border p {
            font-size: var(--font-size-base);
        }

        .upload-icon-wrapper {
            padding: 12px;
            margin-bottom: 4px;
        }

        .upload-icon-wrapper :global(svg) {
            width: 36px;
            height: 36px;
        }
    }

    /* Drag and drop active states */
    .card.drag-active {
        background-color: var(--surface-hover-color);
        border-color: var(--primary-color);
        transform: translate(-6px, -6px);
        box-shadow: 8px 8px 0 var(--shadow-color);
    }

    .reader-card.drag-active {
        border-color: var(--primary-color);
        background-color: var(--surface-hover-color);
        transform: translate(-4px, -4px);
        box-shadow: 12px 12px 0 var(--shadow-color);
    }

    .reader-card.drag-active .dashed-border {
        border-color: var(--primary-color);
        background: color-mix(in srgb, var(--primary-color) 4%, transparent);
    }

    @keyframes float {
        0% {
            transform: translateY(0px);
        }
        50% {
            transform: translateY(-8px);
        }
        100% {
            transform: translateY(0px);
        }
    }

    .reader-card.drag-active .upload-icon-wrapper,
    .card.drag-active .card-icon {
        animation: float 1.2s ease-in-out infinite;
        border-color: var(--primary-color);
        background: var(--primary-color);
        color: var(--primary-text-color);
    }

    .card:disabled {
        opacity: 0.6;
        cursor: wait;
    }

    .reader-card.importing {
        cursor: wait;
        opacity: 0.85;
    }

    @media (prefers-reduced-motion: reduce) {
        .reader-card.drag-active .upload-icon-wrapper,
        .card.drag-active .card-icon {
            animation: none;
        }
    }
</style>
