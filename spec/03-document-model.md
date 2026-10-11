# Document model and adapters

## 1. Responsibility

Document formats are extension contributions. Viewer consumes generic document contracts and never imports PDF.js, EPUB parsers, or DJVU parsers.

The first implementation supports paged and reflowable readers. The model must remain capability-based so a format can expose optional outline, search, text extraction, annotations, links, selection, or thumbnails without changing Viewer imports.

## 2. Adapter contract

```ts
export interface DocumentAdapter {
    readonly id: string
    readonly extensions: readonly string[]
    readonly mimeTypes: readonly string[]

    probe(source: DocumentSource): Promise<ProbeResult>
    open(source: DocumentSource): Promise<OpenedDocument>
}
```

File extensions are only a routing hint. The host may call `probe` to verify the actual format and resolve conflicts. Probe and open operations must respect core resource limits and cancellation.

## 3. Document source

Adapters receive a controlled source, not a raw host storage object:

```ts
export interface DocumentSource {
    readonly id: string
    readonly name: string
    readonly size: number
    readonly mimeType: string | undefined
    read(offset?: number, length?: number, signal?: AbortSignal): Promise<ArrayBuffer>
}
```

The core owns file permissions, object URLs, handles, and source lifetime. `read` must have a bounded maximum length and defined behavior for omitted arguments. Large whole-file reads are prohibited unless the core explicitly permits them.

A future Worker implementation must replace `AbortSignal` and host objects with transfer-safe request and cancellation messages.

## 4. Opened document models

```ts
export type OpenedDocument = PagedDocument | ReflowableDocument

export interface BaseReaderDocument {
    readonly kind: "paged" | "reflowable"
    readonly metadata: DocumentMetadata
    readonly capabilities: ReadonlySet<DocumentCapability>
    close(): Promise<void>
}

export interface PagedDocument extends BaseReaderDocument {
    readonly kind: "paged"
    readonly pageCount: number
    getPage(pageNumber: number): Promise<ReaderPage>
    renderPage(pageNumber: number, options: RenderOptions): Promise<RenderedPage>
}

export interface ReflowableDocument extends BaseReaderDocument {
    readonly kind: "reflowable"
    getSections(): Promise<readonly ReaderSection[]>
}
```

The following types must be defined before the adapter migration is considered complete:

- `DocumentMetadata`
- `DocumentCapability`
- `ReaderPage`
- `ReaderSection`
- `RenderOptions`
- `RenderedPage`
- Capability-specific result and error types

They must use format-neutral values. PDF-specific types must not cross the adapter boundary.

For future runtime adapters, these types must also be serializable or explicitly transferable. A host proxy must not pretend that a Worker object is the same object as a built-in document instance.

## 5. Safety requirements

- Adapters must never inject untrusted document HTML into the host DOM.
- Reflowable content is sanitized or rendered in an isolated document surface.
- Adapters inherit core resource limits and may define stricter limits.
- Parsing, probing, rendering, and search operations are cancellable.
- Adapter errors are namespaced and do not expose document contents in logs.
- Closing a document releases source references, object URLs, caches, and parser resources.

## 6. PDF adapter

`builtin.pdf` owns:

- PDF.js.
- PDF parsing and rendering.
- PDF outline extraction.
- PDF search and indexing.
- PDF-specific resource checks.

It contributes a `PagedDocument` adapter and has no dependency on Viewer UI or stores. Viewer changes are not allowed when adding EPUB or DJVU adapters, except for generic capability support that was missing from the contract.
