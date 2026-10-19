# Reader

Language for the reader's command and settings interactions.

## Language

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
