export interface LibraryErrorDiagnostic {
    readonly code: string
    readonly message: string
}

/** Keep library logs useful without exposing file names, URLs, or adapter details. */
export function getLibraryErrorDiagnostic(
    error: unknown,
    fallback = "The library operation failed",
): LibraryErrorDiagnostic {
    if (!(error instanceof Error)) return { code: "LibraryError", message: fallback }
    const code = /^[A-Za-z][A-Za-z0-9]*Error$/.test(error.name) ? error.name : "LibraryError"
    return { code, message: fallback }
}
