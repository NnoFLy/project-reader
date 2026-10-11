# Built-in plugins

All current product features become built-in extensions. They are bundled and trusted, but use the extension contracts rather than direct `AppShell` wiring.

## 1. Library plugin

Owns:

- Folder and document browser UI.
- Import and relink workflows.
- Selection state.
- File tree commands.
- Book-oriented presentation and metadata.
- Opening documents through the core DocumentService.

It does not access IndexedDB directly and does not import Viewer.

## 2. Prompt plugin

Owns:

- Prompt state and UI.
- Fuzzy filtering.
- Prompt navigation commands.
- Prompt providers.

It reads registered command and provider metadata from core. It does not import Library or Viewer.

## 3. Viewer plugin

Owns:

- Reader workbench UI.
- Paged and reflowable surfaces.
- Reading navigation.
- Zoom and display preferences.
- Reading progress.
- Bookmarks and notes.
- Viewer commands.

It consumes `OpenedDocument` and never imports PDF.js, EPUB parsers, or DJVU parsers.

## 4. Settings plugin

Core owns the settings registry and basic persistence. Settings owns the settings UI and contributes plugin-specific setting controls.

Plugin settings are registered through the settings API. A plugin must not import another plugin's settings store.

## 5. PDF plugin

Owns:

- PDF.js.
- PDF parsing and rendering.
- PDF outline extraction.
- PDF search and indexing.
- PDF-specific resource checks.

It contributes a `PagedDocument` adapter and has no dependency on Viewer UI.

## 6. Cross-plugin communication

Plugins communicate through core contracts:

- Commands for user actions.
- DocumentService for opening generic documents.
- Registries for contributions.
- Notifications for user-visible status.
- Namespaced storage for durable plugin state.

Direct imports between plugins are forbidden, including imports of stores, Svelte components, command factories, and implementation types.

## 7. AppShell migration target

The current `AppShell` manually imports settings, Viewer, documents, commands, Prompt, notifications, bookmarks, and Library relink surfaces. After migration it should only coordinate:

- Host startup and shutdown.
- Global layout and route hosts.
- Host-level notification and modal surfaces.
- Navigation and application lifecycle.

Feature commands, stores, and views are registered by built-in extension activation. A failed plugin must not prevent the host or unrelated plugins from rendering.
