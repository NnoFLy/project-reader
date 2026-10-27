# Reader

Language for the reader's reading sessions, commands, settings, files, and writing.

## Language

**Reading session**:
An open context for a Library document, including its reading position, zoom, page layout, and Note drafts. Reopening the same document selects its existing reading session rather than creating another.
_Avoid_: Current book, document instance

**Reading workspace**:
The reader's open reading sessions and the session currently selected. It is restored after reload, including each session's last reading position.
_Avoid_: Current document, tab state

**Prompt**:
The reader's searchable interface for finding commands or choosing values.
_Avoid_: Dialog, search box

**Command palette**:
The Prompt that lists the commands available to the user.
_Avoid_: Main menu

**Value chooser**:
A Prompt containing the available values for a setting, such as theme or language.
_Avoid_: Toggle, switcher

**Parent Prompt**:
The Prompt a user returns to when backing out of a value chooser, with their previous search and selection preserved.
_Avoid_: Previous page

**Reading position**:
The place within a document from which a Reading session resumes, independent of temporary page breaks caused by font size or viewport changes.
_Avoid_: Current page when referring to a place in reflowable content

**Passage note**:
A saved annotation attached to a text passage in a document.
_Avoid_: Region note when referring to selected text

**Region note**:
A saved annotation attached to a selected area of a document page rather than a text passage.
_Avoid_: Passage note when referring to an image area

**Note draft**:
A passage or region annotation that has not been saved as a note, with its own content and highlight color until saved or discarded. Recovering a draft after reload does not make it a saved note.
_Avoid_: Temporary note

**Linked document**:
A Library document whose source remains in a user-managed file rather than a retained Library copy. Reading it depends on that file remaining accessible.
_Avoid_: Offline copy

**Offline-ready document**:
A document whose source and required reading resources are currently accessible without a network connection. This describes current availability, not a promise of permanent retention or access.
_Avoid_: Downloaded when source access has not been established

### Files and writing

**Note file**:
A standalone Markdown or Org file for writing and organization, distinct from a document-bound passage or region annotation and its Note draft.
_Avoid_: Note when the distinction from an annotation is unclear

**Managed file**:
A file whose retained source is managed by the app rather than kept at an external location. Retention does not protect it from browser eviction or cleared local data.
_Avoid_: Permanent copy

**Linked file**:
A file whose source remains in a user-managed external location, with access and saving dependent on availability and permission. A local recovery copy does not make it a Managed file.
_Avoid_: Imported copy, offline copy

**Local recovery**:
Recovery of pending edits retained locally without implying they reached the file's source. It is neither backup nor a completed Source save.
_Avoid_: Saved when only recovery is available

**Source save**:
A completed write to a file's designated source: its managed source or its linked original. Retaining edits for Local recovery alone is not a source save.
_Avoid_: Saved locally when the source outcome is unclear

**Pending-source edits**:
Edits not yet confirmed written to the designated source, even if a local recovery copy exists.
_Avoid_: Synced, saved

**Source conflict**:
A detected difference between a changed source and the version underlying local edits that requires explicit resolution before replacement.
_Avoid_: Automatically merged when no merge was performed

**Shared file metadata**:
The app's folder organization, tags, and pins shared across file experiences, distinct from file content such as Markdown frontmatter or Org properties.
_Avoid_: Notes-only notebook metadata

**Complete export**:
An export carrying files, attachments, structure, and app-only metadata needed to reconstruct the exported collection.
_Avoid_: Raw file export

**Raw file export**:
An export of file content that does not carry app-only metadata.
_Avoid_: Complete backup
