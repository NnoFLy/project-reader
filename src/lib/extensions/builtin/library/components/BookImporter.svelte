<script lang="ts">
    import PlusIcon from "$lib/shared/icons/PlusIcon.svelte"
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
    :global(.button.brutalist-btn.import-action) {
        min-height: var(--control-height-regular);
        background: var(--primary-color);
        color: var(--primary-text-color);
        font-family: var(--ui-font);
        font-size: var(--font-size-base);
        font-weight: 800;
    }

    @media (hover: hover) and (pointer: fine) {
        :global(.import-action:hover:not(:disabled):not(:active) svg) {
            transform: translateY(-1px) rotate(8deg);
        }
    }

    :global(.button.import-action:disabled) {
        cursor: wait;
        opacity: 0.7;
    }

    :global(.import-action svg) {
        width: 18px;
        height: 18px;
        transition: transform 140ms cubic-bezier(0.4, 0, 0.2, 1);
    }

    .reader-card {
        grid-column: 1 / -1;
        background: var(--surface-color);
        border: var(--border-elevated) solid var(--border-color);
        box-shadow: var(--shadow-elevated);
        margin-top: 4px;
        transition:
            background-color 0.12s ease,
            border-color 0.12s ease;
        overflow: hidden;
    }

    /* Upload Screen */
    .upload-zone {
        padding: clamp(16px, 3vw, 24px);
        text-align: left;
        background: var(--surface-color);
    }

    .dashed-border {
        border: var(--border-inline) dashed var(--border-color);
        padding: clamp(16px, 3vw, 24px);
        display: grid;
        grid-template-columns: auto minmax(0, 1fr) auto;
        grid-template-areas:
            "icon heading action"
            "icon copy action";
        align-items: center;
        gap: 4px 16px;
    }

    .upload-icon-wrapper {
        background: var(--primary-color);
        border: 2.5px solid var(--border-color);
        padding: 12px;
        border-radius: var(--radius-full);
        display: inline-flex;
        box-shadow: var(--shadow-inline);
        color: var(--primary-text-color);
        grid-area: icon;
    }

    .dashed-border h3 {
        margin: 0;
        font-size: var(--font-size-2xl);
        font-weight: 700;
        letter-spacing: -0.02em;
        color: var(--text-color);
        grid-area: heading;
    }

    .empty-copy {
        display: grid;
        gap: 2px;
        grid-area: copy;
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

    .dashed-border :global(.upload-btn) {
        font-size: var(--font-size-md);
        font-weight: 800;
        text-transform: uppercase;
        gap: 6px;
        margin-top: 0;
        background: var(--primary-color);
        grid-area: action;
        color: var(--primary-text-color);
        border-color: var(--border-color);
    }

    @media (hover: hover) {
        .dashed-border :global(.upload-btn:hover:not(:disabled)) {
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
            transform: translate(-1px, -1px);
            box-shadow: 5px 5px 0 var(--shadow-color);
            background-color: var(--surface-hover-color);
        }
    }

    .card:focus-visible:not(:disabled) {
        transform: translate(-1px, -1px);
        box-shadow: 5px 5px 0 var(--shadow-color);
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
            padding: 16px 12px;
        }

        .dashed-border {
            grid-template-columns: auto minmax(0, 1fr);
            grid-template-areas:
                "icon heading"
                "icon copy"
                "action action";
            padding: 16px 12px;
            gap: 4px 12px;
        }

        .dashed-border h3 {
            font-size: var(--font-size-xl);
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
        transform: translate(-1px, -1px);
        box-shadow: 5px 5px 0 var(--shadow-color);
    }

    .reader-card.drag-active {
        border-color: var(--primary-color);
        background-color: var(--surface-hover-color);
        transform: translate(-1px, -1px);
        box-shadow: 5px 5px 0 var(--shadow-color);
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
