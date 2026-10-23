<script lang="ts">
    import { getViewerRuntimeContext } from "../viewerRuntime"
    const {
        notes: notesStore,
        bookmarks: bookmarksStore,
        store: viewerStore,
    } = getViewerRuntimeContext()()
    const viewerUIStore = useViewerUIStore()
    import * as m from "$lib/paraglide/messages"
    import { useViewerUIStore } from "../stores/viewerUIStore.svelte"
    import NotePopup from "./NotePopup.svelte"
    import NoteEditor from "./NoteEditor.svelte"
    import BookmarkAddKeymaps from "./BookmarkAddKeymaps.svelte"
    import Modal from "$lib/shared/ui/modal/Modal.svelte"
    import Input from "$lib/shared/ui/Input.svelte"
    import Button from "$lib/shared/ui/Button.svelte"
    import DeleteConfirmModal from "./DeleteConfirmModal.svelte"
    import type { CommandScope } from "$lib/core/commands"
    import type { ViewerBookmarkAddPayload } from "../commands/viewerCommandPayloads"
    import {
        executeViewerBookmarkDelete,
        executeViewerNoteDelete,
    } from "../commands/viewerMutationExecution"

    let bookmarkAddScope = $state.raw<CommandScope>()

    type BookmarkAddPayload = ViewerBookmarkAddPayload
    function getBookmarkAddPayload(): BookmarkAddPayload {
        return {
            page: viewerUIStore.bookmarkPage,
            name: viewerUIStore.bookmarkName.trim() || `${m.page()} ${viewerUIStore.bookmarkPage}`,
        }
    }

    async function handleConfirmAddBookmark(payload: BookmarkAddPayload) {
        const documentId = viewerUIStore.bookmarkDocumentId
        if (!documentId || viewerUIStore.bookmarkSaving) return
        const requestId = viewerUIStore.bookmarkRequestId
        const page = payload.page ?? viewerUIStore.bookmarkPage
        const name = payload.name?.trim() || `${m.page()} ${page}`
        viewerUIStore.bookmarkSaving = true
        const result = await bookmarksStore.saveBookmark(
            documentId,
            page,
            name,
            viewerUIStore.bookmarkSaveId,
        )
        if (requestId !== viewerUIStore.bookmarkRequestId) return
        viewerUIStore.bookmarkSaving = false
        viewerUIStore.bookmarkFailed = !result?.ok
        if (result?.value && bookmarksStore.bookmarks.some((item) => item.id === result.value?.id))
            viewerUIStore.bookmarkSaveId = result.value.id
        if (result?.ok) viewerUIStore.closeBookmarkAddModal()
    }

    function focusBookmarkName(input: HTMLInputElement) {
        const frame = requestAnimationFrame(() => {
            input.focus()
            input.select()
        })
        return () => cancelAnimationFrame(frame)
    }
</script>

{#if notesStore.activePopup}
    <NotePopup
        activePopup={notesStore.activePopup}
        onClose={() => (notesStore.activePopup = null)}
        onEdit={() => {
            const popup = notesStore.activePopup
            if (!popup) return
            notesStore.openEditor(popup.note)
            notesStore.activePopup = null
        }}
        onDelete={() => {
            const noteId = notesStore.activePopup?.note.id
            if (!noteId) return
            viewerUIStore.noteToDeleteId = noteId
            notesStore.activePopup = null
        }}
    />
{/if}

{#each notesStore.editors.filter((editor) => editor.note.bookId === viewerStore.reading.documentId) as editor (editor.id)}
    <NoteEditor
        editorId={editor.id}
        editorState={editor.note}
        saving={editor.saving}
        draft={editor.draft}
        onDiscard={() => notesStore.discardEditor(editor.id)}
        failed={editor.failed}
        onActivate={() => notesStore.activateEditor(editor.id)}
        onChange={(change) => notesStore.updateEditor(editor.id, change)}
        onSave={() => notesStore.saveEditor(editor.id)}
        onCancel={() => void notesStore.closeEditor(editor.id)}
    />
{/each}

{#if viewerUIStore.noteToDeleteId}
    <DeleteConfirmModal
        message={m.delete_higlight_note()}
        onConfirm={async () => {
            if (!viewerUIStore.noteToDeleteId) return
            await executeViewerNoteDelete({
                noteId: viewerUIStore.noteToDeleteId,
                confirmed: true,
            })
        }}
        onCancel={() => {
            viewerUIStore.noteToDeleteId = null
        }}
    />
{/if}

{#if viewerUIStore.isBookmarkAddModalOpen && viewerUIStore.bookmarkDocumentId === viewerStore.reading.documentId}
    <BookmarkAddKeymaps
        onConfirm={handleConfirmAddBookmark}
        onCancel={() => viewerUIStore.closeBookmarkAddModal()}
        getPayload={getBookmarkAddPayload}
        bind:scope={bookmarkAddScope}
    />
    <Modal
        variant="default"
        type="float"
        size="medium"
        placement="center"
        onClose={() => void bookmarkAddScope?.execute("modal.cancel")}
        title={m.add_bookmark()}
        closeLabel={m.close()}
        initialFocus={() => document.getElementById("header-bookmark-name-input")}
        draggable
    >
        <div class="modal-form">
            {#if viewerUIStore.bookmarkFailed}
                <p role="alert">{m.reading_annotations_error()}</p>
            {/if}
            <Input
                disabled={viewerUIStore.bookmarkSaving}
                id="header-bookmark-name-input"
                attachment={focusBookmarkName}
                placeholder={m.bookmark_name_placeholder
                    ? m.bookmark_name_placeholder()
                    : "Bookmark name..."}
                label={m.bookmark_page()}
                bind:value={viewerUIStore.bookmarkName}
                onkeydown={(e) => {
                    if (e.key === "Enter" && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
                        e.preventDefault()
                        void bookmarkAddScope?.execute("viewer.bookmark.add", {
                            page: viewerUIStore.bookmarkPage,
                            name:
                                viewerUIStore.bookmarkName.trim() ||
                                `${m.page()} ${viewerUIStore.bookmarkPage}`,
                        })
                    }
                }}
            />
        </div>

        {#snippet footer()}
            <div class="modal-actions">
                <Button
                    variant="close"
                    onclick={() => void bookmarkAddScope?.execute("modal.cancel")}
                >
                    {m.cancel()}
                </Button>
                <Button
                    variant="brutalist"
                    disabled={viewerUIStore.bookmarkSaving}
                    onclick={() =>
                        void bookmarkAddScope?.execute("viewer.bookmark.add", {
                            page: viewerUIStore.bookmarkPage,
                            name:
                                viewerUIStore.bookmarkName.trim() ||
                                `${m.page()} ${viewerUIStore.bookmarkPage}`,
                        })}
                >
                    {m.add_bookmark()}
                </Button>
            </div>
        {/snippet}
    </Modal>
{/if}

{#if viewerUIStore.bookmarkToDeleteId}
    <DeleteConfirmModal
        message={m.delete_bookmark_confirm()}
        onConfirm={async () => {
            if (viewerUIStore.bookmarkToDeleteId) {
                await executeViewerBookmarkDelete({
                    bookmarkId: viewerUIStore.bookmarkToDeleteId,
                    confirmed: true,
                })
            }
        }}
        onCancel={() => {
            viewerUIStore.bookmarkToDeleteId = null
        }}
    />
{/if}
