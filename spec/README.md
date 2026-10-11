# Plugin Architecture Specifications

**Status:** proposed implementation specification

This directory is the canonical home for the plugin architecture refactor. The previous monolithic proposal was split into focused specifications so the built-in architecture can be implemented without committing the project to runtime-installed extensions prematurely.

## Specifications

1. [Architecture and boundaries](./01-architecture.md)
2. [Extension API and contributions](./02-extension-api.md)
3. [Document model and adapters](./03-document-model.md)
4. [Built-in plugins](./04-built-in-plugins.md)
5. [Host lifecycle and storage](./05-host-lifecycle-storage.md)
6. [Deferred runtime extensions](./06-runtime-extensions-deferred.md)
7. [Migration and acceptance](./07-migration-acceptance.md)

## Implementation stance

The first implementation covers built-in extensions and document-format adapters in the normal Svelte runtime. Runtime-installed extensions, package installation, Worker RPC, and webviews remain a later project with separate security and protocol review.

The architecture still reserves stable contracts for that future work, but does not treat a browser Worker as a malicious-code sandbox. The initial runtime-extension trust model is trusted extension code with a responsiveness boundary.

## Decisions

- The current public module APIs are not preserved.
- Built-in extensions use the public framework-neutral contracts wherever practical.
- Built-in extensions may use native Svelte components internally.
- SvelteKit filesystem routes remain host-owned and static.
- Document formats are extension contributions, not Viewer imports.
- IDs are namespaced by extension.
- Core owns infrastructure and generic application concepts, not product-specific behavior.
- Runtime extensions must not be implemented until the wire protocol and trust model are specified separately.
