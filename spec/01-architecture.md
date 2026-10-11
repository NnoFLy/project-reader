# Architecture and boundaries

## 1. Goals

- Make feature ownership explicit.
- Prevent plugins from importing one another directly.
- Add document formats without modifying Viewer code.
- Keep built-in Svelte UI ergonomic.
- Keep core independent of Svelte and product-specific features.
- Keep SvelteKit routing static while allowing extension-contributed views.
- Preserve offline-first behavior.
- Make extension lifecycle, storage, permissions, and cleanup explicit.

## 2. Non-goals for the first implementation

- Preserving the current public module APIs.
- Dynamically adding SvelteKit filesystem routes.
- Letting extensions import arbitrary application internals.
- Exposing Svelte components as the stable external extension API.
- Building a marketplace.
- Treating runtime-installed code as hostile or fully sandboxed.
- Supporting arbitrary Node.js extensions in the browser.

## 3. Runtime model

### Built-in extensions

Built-in extensions are bundled with the application and trusted by the host. They use the normal Svelte runtime and may provide native Svelte components. They must use the same public contracts as future installed extensions wherever practical.

Initial built-ins:

- `builtin.library`
- `builtin.prompt`
- `builtin.viewer`
- `builtin.settings`
- `builtin.pdf`

### Future runtime extensions

Runtime-installed extensions are specified separately in [Deferred runtime extensions](./06-runtime-extensions-deferred.md). They are not required for the first migration.

## 4. Target source layout

```text
src/lib/
  core/
    app/
    commands/
    documents/
    files/
    navigation/
    notifications/
    settings/
    storage/
    ui/
    workbench/

  extension-api/
    contracts.ts
    commands.ts
    documents.ts
    permissions.ts
    settings.ts
    storage.ts
    views.ts

  extension-host/
    host.ts
    lifecycle.ts
    contribution-registry.ts
    dependency-resolution.ts

  extensions/
    builtin/
      library/
      prompt/
      viewer/
      settings/
      pdf/

  document-model/
    reader-document.ts
    paged-document.ts
    reflowable-document.ts
    document-source.ts

  shared/

src/routes/
  +layout.svelte
  +page.svelte
  viewer/[documentId]/+page.svelte
  extensions/+page.svelte
```

The current `src/lib/modules` tree is removed after migration. The `extensions/+page.svelte` route is host-owned and may later manage installed extensions; it is not itself a dynamic filesystem route.

## 5. Layer responsibilities

### Core owns

- Application startup and shutdown.
- Extension discovery, activation, failure, disabling, and disposal.
- Command registration and execution.
- Keybinding dispatch.
- Basic settings and persistence.
- Generic file and folder storage.
- File access and permission handling.
- Document source access.
- Notifications.
- Navigation and workbench slots.
- Extension-scoped storage.
- Static route hosts.
- Security and resource limits.

### Core must not own

- Books as a special data type.
- PDF metadata or PDF.js types.
- EPUB parsing.
- Viewer-specific layout state.
- Library-specific commands.
- Prompt-specific selection state.
- Adapter-specific storage tables.

## 6. Bootstrap and routes

The application bootstrap creates one built-in extension host. The host:

1. Registers the built-in manifests.
2. Validates IDs and contribution metadata.
3. Resolves dependencies.
4. Activates startup extensions.
5. Publishes contribution registries to route hosts.
6. Disposes the host during application shutdown.

`AppShell` owns global host layout, modal surfaces, notifications, and lifecycle wiring. It must not import feature stores, commands, or components from individual plugins. Static routes import host-owned route surfaces, which select registered contributions.

Built-in native views are registered during activation. Route rendering must tolerate a contribution that is not available because its extension failed.

## 7. Dependency boundaries

```text
core             -> core
extension-api    -> core contracts only
built-in plugin  -> core + extension-api + own files
adapter          -> core document contracts + extension-api
extension-host   -> core + extension-api
routes           -> workbench/host only
shared           -> core-safe code only
```

Forbidden imports include:

- Core importing a plugin or adapter implementation.
- One plugin importing another plugin.
- Viewer importing a document adapter implementation.
- An adapter importing Viewer components or stores.
- Routes importing feature internals.
- Shared code importing application features.
- Future runtime extensions importing `$lib` application paths.

## 8. Boundary enforcement

The boundary checker must validate both import paths and contribution IDs. It should report:

- Imports that cross a forbidden layer.
- Deep imports into another plugin.
- Cyclic plugin dependencies.
- Unnamespaced command, view, setting, or adapter IDs.
- Contributions registered outside the extension namespace.

The checker is an architectural test, not only a formatting or type check.
