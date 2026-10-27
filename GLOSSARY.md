# Reader

Language for the reader's reading sessions, commands, settings, and editing interactions.

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
