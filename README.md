# Project Reader 📚

An elegant, high-performance, and feature-rich offline-first web-based PDF e-reader designed for a distraction-free, premium reading experience. Powered by **Svelte 5 (Runes Mode)**, **TypeScript**, and **IndexedDB**.

---

## ✨ Key Features

### 📁 Offline-First Virtual File System (VFS)

- **High-Performance Storage**: Fully managed directory structures and file metadata persisted locally using IndexedDB through **Dexie.js**.
- **Modern File API Integration**: Support for the **Web File System Access API** (`showOpenFilePicker`), allowing lazy-loaded, secure local file access without duplicating large binary assets into IndexedDB storage.
- **Asset Management**: Complete directory tree navigation, breadcrumbs, folder creation, interactive file cards, bulk selection, item movement, and deletion.

### 📄 Advanced PDF Rendering Engine

- **Dynamic Rasterization**: HTML5 Canvas-based rendering layer with lazy page load, rendering queues, and memory footprint management.
- **Precise Zoom & Quality Controls**: Smooth scaling from **25% up to 500%** and adjustable rendering quality metrics to balance fidelity and hardware performance.
- **Multi-Page Layouts**: Multiple view modes including **Single Page**, **Two Pages (Split)**, and seamless **Scroll View**.
- **Intelligent Document Outline**: Multi-level chapter/heading outline sidebar extraction with destination mapping to jump directly to specific pages.

### ⌨️ Deep Keymap & Navigation System

- **Hierarchical Keymaps**: Custom state-aware keymap registry (`keymapStore`) allowing dynamic registration and scoping of hotkeys depending on the active component.
- **Keyboard-First Interface**: Full keyboard-only workflow for scrolling (`J`/`K` or arrows), sidebar toggling, zooming, folder navigation, and configuration controls.

### 🔍 Spotter & Command Palette

- **Unified Command Center**: Spotlight-style command palette (`Ctrl+K`) for immediate navigation and action triggering.
- **Fuzzy Searching**: Fuzzy match search across available books, navigation actions, and settings commands using `fuse.js`.
- **Page-Jump Mode**: Input any number in page mode to instantly transition directly to that specific slide or page.

### 🌐 Localization (I18n)

- **Bilingual Support**: Fully translated into **English** and **Russian** (`en.json`, `ru.json`).
- **Svelte I18n Engine**: Powered by `@inlang/paraglide-js` for compile-time typesafe localized messages.

---

## 🎨 Design & Aesthetic System

The project features a **premium Brutalist-modern hybrid interface** with:

- **Harmonious Palette**: High-contrast, meticulously designed light, dark, and system themes.
- **Fluid Dynamics**: Smooth CSS transitions and optional micro-animations (toggled via settings).
- **Responsive Layouts**: Fully responsive media queries optimized for mobile and desktop screens.
- **Clean Components**: Modular and reusable UI buttons, modal views, and toggles following a cohesive styling architecture.

---

## 🛠️ Technology Stack

| Technology       | Purpose                                                                              |
| :--------------- | :----------------------------------------------------------------------------------- |
| **Svelte 5**     | Core framework utilising reactive Runes (`$state`, `$derived`, `$effect`) & Snippets |
| **SvelteKit**    | Routing, server/client hooks, static asset delivery, and layout rendering            |
| **TypeScript**   | Strict compile-time static typing                                                    |
| **Dexie.js**     | Fluent IndexedDB wrapper for database migrations and query executions                |
| **PDF.js**       | Mozilla's robust PDF parsing and rendering API                                       |
| **Fuse.js**      | Client-side fuzzy-search engine for the spotlight command prompt                     |
| **Paraglide-js** | Standardized internationalization compiler                                           |
| **PostCSS**      | CSS preprocessing and custom media query integration                                 |

---

## 📂 Project Structure

```
├── messages/               # Internationalization message JSONs (en, ru)
├── src/
│   ├── lib/
│   │   ├── app/            # Application shell and global command registration
│   │   ├── modules/        # Feature modules (commands, library, PDF, prompt, settings, viewer)
│   │   │   ├── pdf/        # PDF loading, caching, and document helpers
│   │   │   └── viewer/      # Viewer commands, state, components, and styles
│   │   └── shared/         # Shared state, styles, icons, actions, and UI primitives
│   └── routes/
│       ├── +layout.svelte  # Global application layout
│       ├── +page.svelte    # Home library route
│       └── viewer/         # PDF document viewer route
├── Caddyfile               # Internal HTTP server and security headers
├── Dockerfile              # Multi-stage production container instructions
└── docker-compose.yml      # Production service definition
```

---

## 🚀 Getting Started

### Prerequisites

Make sure you have [Node.js v22+](https://nodejs.org/) and the **`pnpm`** package manager installed.

### Installation

Clone the repository and install all dependencies:

```sh
pnpm install
```

### Development Server

Run the local development environment:

```sh
pnpm run dev
```

Open [http://localhost:5173](http://localhost:5173) in your browser.

### Quality Assurance (Lint & Type-Check)

Perform TypeScript type analysis and check project integrity:

```sh
pnpm run check
```

Execute speed-optimized formatting and linting rules using `oxlint` and `oxfmt`:

```sh
# Lint and verify rules
pnpm run lint

# Format the codebase
pnpm run format
```

### Production Bundling

Build and bundle the static client application:

```sh
pnpm run build
```

Verify the generated production release locally:

```sh
pnpm run preview
```

---

## 🐳 Production deployment

The multi-stage `Dockerfile` builds the static SvelteKit application with Node.js 22 and serves it with a pinned Caddy image. The container serves HTTP on its internal port 80 and is published on host loopback port 8000; public HTTPS is provided by a host Caddy reverse proxy. No production address is embedded in the image.

For a local container check:

```sh
docker build --build-arg RELEASE=development -t project-reader:local .
PRODUCTION_HOST=localhost DEPLOY_IMAGE=project-reader:local docker compose up --detach --wait
curl -H 'Host: localhost' http://127.0.0.1:8000/health/version
```

Every pull request builds the production bundle and production container without registry or deployment credentials. A successful push to protected `master` scans and publishes the exact tested image by digest, attaches provenance and an SPDX SBOM, then deploys that digest. Activation verifies the revision internally and over public HTTPS; failure restores the previous image with its own immutable Compose configuration.

Production requires the `PRODUCTION_HOST` and `PRODUCTION_URL` environment variables plus dedicated SSH secrets. Host bootstrap, GitHub protection settings, rootless Docker configuration, backups, retention, and recovery commands are documented in [`docs/production-runbook.md`](docs/production-runbook.md). Vulnerability suppressions follow [`.github/VULNERABILITY_EXCEPTIONS.md`](.github/VULNERABILITY_EXCEPTIONS.md).

---

## ⌨️ Essential Keyboard Shortcuts

| Shortcut                    | Action                                                | Scope                   |
| :-------------------------- | :---------------------------------------------------- | :---------------------- |
| **`Ctrl` + `K`**            | Toggle global Spotter/Command Prompt                  | Application-wide        |
| **`O`**                     | Search/open imported books                            | Application-wide        |
| **`Shift` + `T`**           | Toggle light / dark / system theme                    | Application-wide        |
| **`Shift` + `L`**           | Toggle layouts (Single, Two-Pages, Scroll)            | Viewer                  |
| **`J`** / **`Arrow Down`**  | Smooth scroll page down                               | Viewer / Content panels |
| **`K`** / **`Arrow Up`**    | Smooth scroll page up                                 | Viewer / Content panels |
| **`Shift` + `A`** (Library) | Create a new folder (or select all in selection mode) | Home Library Screen     |
| **`Esc`**                   | Close sidebar panels, modals, and Command Prompt      | Active popup / menu     |
