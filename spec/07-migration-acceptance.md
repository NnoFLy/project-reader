# Migration and acceptance

## 1. Refactoring sequence

### Phase 0: Baseline

- Record current behavior and public user flows.
- Add architecture tests for forbidden imports and namespaced IDs.
- Define the missing generic document types.
- Keep existing user-facing functionality green throughout the migration.

### Phase 1: Contracts and built-in host

- Create `extension-api` contracts.
- Create extension manifests and lifecycle states.
- Create contribution registries.
- Create a built-in extension host.
- Add a fake document adapter for tests.
- Add host bootstrap and static route hosts.

### Phase 2: Core infrastructure

- Extract generic file and folder storage from VFS.
- Extract file source access and object URL lifecycle.
- Extract core settings, commands, notifications, and storage.
- Add DocumentService and adapter routing.

### Phase 3: Prompt plugin

- Move Prompt state and UI into the plugin.
- Replace direct command imports with the command registry.
- Make Prompt consume registered commands and prompt providers.

### Phase 4: Viewer plugin

- Split common reader behavior from PDF-specific behavior.
- Implement paged and reflowable viewer surfaces.
- Move progress, bookmarks, and notes behind viewer storage.
- Add a fake adapter integration test.

### Phase 5: PDF plugin

- Move PDF.js and PDF resource limits into `builtin.pdf`.
- Implement the paged document adapter.
- Remove PDF imports from Viewer and core.
- Preserve search, outline, rendering, and metadata behavior through contracts.

### Phase 6: Library and settings plugins

- Move the file browser and import UI into `builtin.library`.
- Replace book-specific VFS calls with core file and document services.
- Open documents through DocumentService.
- Remove direct Library-to-Viewer dependencies.
- Move settings UI and plugin-specific controls into `builtin.settings`.

### Phase 7: Additional adapters

- Add EPUB as a reflowable adapter.
- Add DJVU as a paged adapter.
- Verify that Viewer changes are unnecessary when adding each adapter.

### Phase 8: Runtime extensions, later project

- Implement only after [Deferred runtime extensions](./06-runtime-extensions-deferred.md) passes its go/no-go criteria.
- Add package storage, Worker RPC, permission checks, lifecycle recovery, and webviews as separate milestones.

## 2. Acceptance criteria for the first implementation

The built-in refactor is complete when:

- All current functionality is provided by built-in extensions.
- `AppShell` no longer manually imports and wires every feature.
- Core has no imports from plugin or adapter implementations.
- Viewer has no PDF.js dependency.
- PDF has no Viewer component or store dependency.
- Library opens generic documents through core services.
- Prompt discovers commands through the registry.
- Built-in extensions activate and dispose through the same lifecycle.
- Extension storage survives reload and is isolated by namespace.
- Invalid contributions, dependency cycles, and activation errors do not break the host.
- EPUB and DJVU adapters can be added without format-specific Viewer imports.
- Boundary, type, unit, integration, and build checks pass.

## 3. Runtime acceptance criteria for the later project

Runtime work is complete only when:

- A runtime-installed trusted Worker extension can register a command and be disabled cleanly.
- A runtime-installed document extension can register an adapter and open a test document.
- Wire-level cancellation, errors, quotas, and disposal are tested.
- Package integrity, update, rollback, and explicit enablement are tested.
- Webview isolation and message validation are tested.
- The trust model is documented accurately and does not claim that a Worker alone prevents malicious behavior.
