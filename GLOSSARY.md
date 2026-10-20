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

**Note draft**:
A passage annotation that has not been saved as a note, with its own content and highlight color until saved or discarded. Recovering a draft after reload does not make it a saved note.
_Avoid_: Temporary note
