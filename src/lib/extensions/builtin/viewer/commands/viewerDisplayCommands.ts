import { defineCommands } from "$lib/modules/commands"
import * as m from "$lib/paraglide/messages"

export interface ViewerDisplayPort {
    toggleOutline(): void
    toggleSettings(): void
    toggleNotes(): void
    toggleBookmarks(): void
    toggleToolbar(): void
    toggleFullscreen(): void | Promise<void>
}

export function createViewerDisplayCommands(display: ViewerDisplayPort) {
    return defineCommands({
        "viewer.sidebar.outline.toggle": {
            id: "viewer.sidebar.outline.toggle",
            keymap: "shift+o",
            label: () => m.keymap_toggle_outline(),
            englishLabel: () => m.keymap_toggle_outline({}, { locale: "en" }),
            category: "commands",
            run: () => display.toggleOutline(),
        },
        "viewer.sidebar.settings.toggle": {
            id: "viewer.sidebar.settings.toggle",
            keymap: "shift+s",
            label: () => m.keymap_toggle_settings(),
            englishLabel: () => m.keymap_toggle_settings({}, { locale: "en" }),
            category: "commands",
            run: () => display.toggleSettings(),
        },
        "viewer.sidebar.notes.toggle": {
            id: "viewer.sidebar.notes.toggle",
            keymap: "shift+h",
            label: () => m.keymap_toggle_notes(),
            englishLabel: () => m.keymap_toggle_notes({}, { locale: "en" }),
            category: "commands",
            run: () => display.toggleNotes(),
        },
        "viewer.sidebar.bookmarks.toggle": {
            id: "viewer.sidebar.bookmarks.toggle",
            keymap: "shift+b",
            label: () => m.keymap_toggle_bookmarks(),
            englishLabel: () => m.keymap_toggle_bookmarks({}, { locale: "en" }),
            category: "commands",
            run: () => display.toggleBookmarks(),
        },
        "viewer.toolbar.toggle": {
            id: "viewer.toolbar.toggle",
            keymap: "shift+m",
            label: () => m.keymap_hide_toolbars(),
            englishLabel: () => m.keymap_hide_toolbars({}, { locale: "en" }),
            category: "commands",
            run: () => display.toggleToolbar(),
        },
        "viewer.fullscreen.toggle": {
            id: "viewer.fullscreen.toggle",
            label: () => m.toggle_fullscreen(),
            englishLabel: () => m.toggle_fullscreen({}, { locale: "en" }),
            category: "commands",
            run: () => display.toggleFullscreen(),
        },
    })
}
