# Extend local reading without forcing every format into pages

Add unprotected EPUB, DjVu, CBZ, and CBR to the existing reading workspace through format adapters, retaining the ownership established in [ADR-0001](0001-viewer-owned-reading-workspace.md). Preserve reflowable EPUB and content-based reading positions instead of converting books into fixed pages or creating separate ebook and comic workspaces. Keep processing on-device for privacy and offline use, accepting the need for bounded decoding and device validation rather than introducing a conversion service.

This is an accepted design direction, not a claim that these formats are implemented. Feature specifications and implementation tasks belong in GitHub Issues.

## Scope and trade-offs

- Deliver EPUB first, including reflowable and fixed-layout books; accept later formats independently. Exclude DRM-protected books.
- Target capability-aware parity with existing reading features. Search, text selection, and passage notes use usable source text; do not add OCR. Image-only pages support region notes and bookmarks, without pretending text features are available.
- Offer pagination and continuous scrolling for reflowable EPUB. Keep only current and nearby reading-order sections mounted, loading and unloading across boundaries. A section need not match a table-of-contents chapter; exceptionally large sections need finer-grained rendering bounds.
- Preserve reading positions, bookmarks, and note anchors across font-size, viewport, and reading-mode changes for the same document content. Changed replacement files require explicit anchor verification; cross-edition migration is not promised.
- For comics, support left-to-right and right-to-left reading, single pages and two-page spreads, but not guided panel navigation. Naturally sort image paths, so page2 precedes page10, rather than relying on archive entry order; ignore non-page artifacts. Reading direction changes presentation, not the underlying sequence.
- Open and navigate before whole-book text indexing finishes. Index progressively and show progress and incomplete-result status rather than presenting partial search results as complete.
- Require offline reading once the app, decoder, and source content are available. Permit linked documents, but distinguish them from retained Library copies and report missing files or lost permissions; a linked document is not inherently offline-ready. Browser eviction or cleared site data can remove retained content.
- Include desktop, iPhone/iPad Safari, and Android Chrome in acceptance. Target source files up to 1 GiB, subject to bounded decompression and representative device testing; this is not yet a support guarantee.

## Consequences and validation gates

Page numbers alone cannot represent durable reflowable positions, and text offsets alone cannot represent region notes. Extend those concepts within Viewer rather than moving reading state into Core or Library. Do not select a locator encoding or decoder solely from a capability declaration: validate rendering, text geometry, resource access, cleanup, and cancellation for each format.

Chapter windowing does not bound archive extraction, indexing, or identity hashing. At the time of this decision, source identity hashing allocates a whole-file buffer, and the PDF path also buffers the complete file; increasing the current 100 MiB limit alone is insufficient. Validate bounded source access, hashing, decoding, oversized-section handling, background indexing, and storage behavior on concrete mobile devices before claiming the 1 GiB target. Decoder choices, numerical resource budgets, device baselines, and performance thresholds remain implementation-planning gates, not settled promises.

The trust boundary is the imported document and all embedded content. Sanitize and isolate EPUB content, prohibit embedded script execution and automatic external-resource loads, and bound archive expansion, decoded image sizes, and rendering resources. Local processing must not upload document content. These are required protections for implementation, not controls introduced by this documentation change.
