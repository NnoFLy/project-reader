# Brutalist theme

Reference for the app's original appearance, before the flat light/true-black redesign. This document records the visual rules needed to restore it as a selectable theme; it does not add a theme picker or change the current interface.

| Property           | Value                                                |
| ------------------ | ---------------------------------------------------- |
| Display name       | Brutalist                                            |
| Suggested theme ID | `brutalist`                                          |
| Color modes        | Light and dark; system follows the device preference |
| Historical source  | Commit `36daebe38c13147ad1d3b062bb8e6a9bdec99da3`    |

## Visual identity

The original interface used square controls, strong outlines, and hard offset shadows. Its light mode combined a cream canvas with white panels, cyan actions, yellow active states, and violet selection. Dark mode used a black canvas, near-black panels, lavender actions, and cyan focus indicators.

Its defining features were:

- **Visible structure:** 2px borders around controls, document cards, toolbars, and panels.
- **Hard elevation:** shadows offset down and right, without blur or spread.
- **Square geometry:** no corner rounding on ordinary controls or panels. The circular import icon and mobile prompt button were exceptions.
- **Heavy typography:** bold labels, compact text, and uppercase treatment on some actions and metadata.
- **Physical feedback:** controls lifted slightly on hover and moved toward their shadow on press.

This was not a glass, gradient, or soft-shadow theme.

## Color palettes

These are the original semantic token values. Token names match the source so a future implementation can map them without guessing.

| Token                    | Light                  | Dark                |
| ------------------------ | ---------------------- | ------------------- |
| `--color-canvas`         | `#f5f0e1`              | `#000000`           |
| `--color-surface`        | `#ffffff`              | `#09090b`           |
| `--color-surface-raised` | `#ffffff`              | `#111113`           |
| `--color-text`           | `#1a1a1a`              | `#e4e4e7`           |
| `--color-text-muted`     | `#666666`              | `#a1a1aa`           |
| `--color-rule`           | `#1a1a1a`              | `#71717a`           |
| `--color-control-border` | `#1a1a1a`              | `#71717a`           |
| `--color-action`         | `#00cec9`              | `#a78bfa`           |
| `--color-on-action`      | `#1a1a1a`              | `#09090b`           |
| `--color-marker`         | `#ffde4d`              | `#8b5cf6`           |
| `--color-on-marker`      | `#1a1a1a`              | `#09090b`           |
| `--color-danger`         | `#ff7675`              | `#f87171`           |
| `--color-on-danger`      | `#1a1a1a`              | `#09090b`           |
| `--color-focus`          | `#6c5ce7`              | `#67e8f9`           |
| `--color-disabled`       | `#eeeeee`              | `#18181b`           |
| `--color-on-disabled`    | `#666666`              | `#a1a1aa`           |
| `--color-viewer-canvas`  | `#ffffff`              | `#000000`           |
| `--color-viewer-chrome`  | `#f5f0e1`              | `#09090b`           |
| `--color-overlay`        | `rgb(26 26 26 / 0.24)` | `rgb(0 0 0 / 0.24)` |

Supporting colors were separate from the semantic palette:

| Role                    | Light                 | Dark                  |
| ----------------------- | --------------------- | --------------------- |
| Hover surface           | `#faf8f5`             | `#1c1c1e`             |
| Shadow                  | `#1a1a1a`             | `#000000`             |
| Selection fill          | `#6c5ce7`             | `#a78bfa`             |
| Text on selection       | `#ffffff`             | `#09090b`             |
| Reading progress        | `#00cec9`             | `#a78bfa`             |
| Destructive hover       | `#ff4d4d`             | `#ef4444`             |
| Inverted surface / text | `#1a1a1a` / `#f5f0e1` | `#e4e4e7` / `#000000` |

The selected surface mixed selection color into the normal surface: 18% in light mode and 22% in dark mode. The focus ring mixed the focus color at 65% with transparency.

Action, marker, selection, danger, and focus had different jobs. Restoring this theme should not collapse them into one accent color.

## Typography

Both fonts were self-hosted and included Latin and Cyrillic characters.

| Role                   | Font          | Use                                                        |
| ---------------------- | ------------- | ---------------------------------------------------------- |
| Interface and headings | IBM Plex Sans | Navigation, controls, titles, and body text                |
| Data and metadata      | IBM Plex Mono | Page counts, progress, author metadata, and shortcut hints |

The base interface size was `0.875rem`, input text was `1rem`, and body line height was `1.45`. The font scale included `0.75rem`, `0.875rem`, `1rem`, `1.125rem`, `1.25rem`, `1.5rem`, `1.75rem`, `2rem`, `2.25rem`, and `3rem`.

Headings commonly used weight 700 with tight tracking. Card titles and prominent actions used 800 or 900. Some small labels and action text were uppercase. Numeric displays used tabular figures, often through IBM Plex Mono.

The historical tokens also included `0.5rem`, `0.625rem`, and `0.6875rem` text. Preserve these as historical information, not requirements to restore unreadably small labels.

## Borders, shadows, and spacing

| Property                        | Original value                                       |
| ------------------------------- | ---------------------------------------------------- |
| Inline border                   | `2px solid`                                          |
| Elevated border                 | `2px solid`                                          |
| Inline shadow                   | `2px 2px 0 var(--shadow-color)`                      |
| Elevated shadow                 | `4px 4px 0 var(--shadow-color)`                      |
| Ordinary corner radii           | `0`                                                  |
| Circular radius                 | `50%`                                                |
| Compact control height          | `36px`                                               |
| Regular / mobile control height | `44px`                                               |
| Control gap                     | `8px`                                                |
| Control horizontal padding      | `12px`                                               |
| Spacing scale                   | `4px`, `8px`, `12px`, `16px`, `24px`, `32px`, `48px` |

Shadows were part of the theme's geometry, not an ambient lighting effect. Do not replace them with blurred drop shadows when recreating this appearance.

## Interaction states

| State                    | Original treatment                                                                            |
| ------------------------ | --------------------------------------------------------------------------------------------- |
| Resting action button    | White or near-black surface, outlined edge, and 2px offset shadow                             |
| Resting prominent button | Outlined edge and 4px offset shadow; import actions used the action fill                      |
| Hover                    | Typically `translate(-1px, -1px)` with a larger shadow to keep its apparent position anchored |
| Pressed                  | A positive translation toward the shadow, with a smaller or removed shadow                    |
| Open / active            | Marker-colored fill on ordinary action controls                                               |
| Selected document        | Selection-colored border, tinted surface, and a strong inset selection edge                   |
| Keyboard focus           | Visible ring using the focus color, independent of selection                                  |
| Disabled                 | Muted surface and unavailable cursor; no hover lift                                           |

For a 2px resting shadow, the original action-button hover used a 3px shadow with a −1px translation. For a 4px resting shadow, the prominent-button hover used 5px. The offset and translation added up to the same apparent shadow position.

Button transitions were typically 100ms; card transitions were typically 150ms. They named the animated properties rather than using `transition: all`. Reduced motion and the app's animation preference must still be respected.

## Component treatments

### Library

- The header had a strong bottom rule and a bold title.
- Document cards used outlined covers, hard shadows, and bold metadata.
- Reading progress occupied a visible band over the bottom of the cover, with a colored fill and percentage label.
- Format, pin, and selection markers had outlined edges and offset shadows.
- The empty-library importer used an outlined outer panel, a dashed inner drop zone, and a circular action-colored plus icon.
- The import button used the action fill with its paired foreground color.

### Document viewer

- Header and footer used the chrome color with strong separating borders.
- Page inputs and range-slider thumbs had square, outlined geometry.
- Page-number labels used marker-colored badges with hard shadows.
- The floating utility rail was rectangular, outlined, and shadowed.
- Sidebars used bold, often uppercase section labels. Active options had clear selection fills or inset markers.
- Notes and bookmarks used outlined cards with offset shadows. Annotation colors represented the user's highlights, not navigation state.

PDF page rendering is separate from chrome styling. The historical dark viewer applied `invert(1) hue-rotate(180deg)` to rendered PDF images. A future theme must preserve document readability rather than applying a filter to the entire interface.

## Restoring it as an additional theme

Treat **visual theme** and **color mode** as separate choices: Brutalist is an appearance; light, dark, and system determine which palette it uses. These are conceptual choices, not a new settings API introduced by this document.

Restoring the theme requires more than swapping color variables. The original appearance also lived in component borders, shadows, radii, typography, and interaction rules. Keep those rules scoped to the selected theme instead of making every theme inherit the brutalist geometry.

Keep current routes, commands, document state, localization, responsive layouts, and accessibility fixes. A theme change must not reset reading progress, change documents, hide control labels, or remove keyboard access to the reading region.

The historical palette is not a guarantee that every foreground/background combination is accessible. Validate each actual component state, including update controls, note actions, loading indicators, focus, and disabled states. Use paired action foregrounds on action fills, retain forced-colors support, and keep touch targets usable on phones.

### Historical source

Read the original token definitions without changing the working tree:

```bash
git show 36daebe38c13147ad1d3b062bb8e6a9bdec99da3:src/lib/shared/styles/variables.css
git show 36daebe38c13147ad1d3b062bb8e6a9bdec99da3:src/lib/shared/styles/typography.css
```

The same commit contains the original component styling in `src/lib/shared/ui/Button.svelte`, `src/lib/extensions/builtin/library/components/`, and `src/lib/extensions/builtin/viewer/components/`. Its button and card tests record the old shadow-anchoring behavior. Use those files as references, not as replacements for the current components.
