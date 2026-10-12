export interface ViewerStorageErrorDiagnostic {
    readonly code: string
    readonly message: string
}

/** Keep viewer persistence logs useful without exposing document data or exception stacks. */
export function getViewerStorageErrorDiagnostic(
    error: unknown,
    message: string,
): ViewerStorageErrorDiagnostic {
    const errorName =
        typeof error === "object" &&
        error !== null &&
        "name" in error &&
        typeof error.name === "string"
            ? error.name
            : null
    const code =
        errorName && /^[A-Za-z][A-Za-z0-9]*Error$/.test(errorName)
            ? errorName
            : "ViewerStorageError"
    return { code, message }
}
