import type { AppExtension, ExtensionManifest } from "../../extension-api"
import { ExtensionHost, type ExtensionHostOptions } from "../../extension-host"

const manifest = (
    id: string,
    name: string,
    activationEvents: ExtensionManifest["activationEvents"],
): ExtensionManifest => ({
    id,
    name,
    version: "0.0.1",
    engine: ">=0.0.1",
    entry: `builtin/${id.replace("builtin.", "")}`,
    activationEvents,
    permissions: ["commands", "documents", "notifications", "storage", "views"],
})

export const BUILTIN_MANIFESTS = [
    manifest("builtin.library", "Library", [{ type: "startup" }]),
    manifest("builtin.prompt", "Prompt", [{ type: "startup" }]),
    manifest("builtin.viewer", "Viewer", [{ type: "startup" }]),
    manifest("builtin.settings", "Settings", [{ type: "startup" }]),
    manifest("builtin.pdf", "PDF", [{ type: "onDocumentType", extension: "pdf" }]),
] as const

const emptyExtensions: readonly AppExtension[] = BUILTIN_MANIFESTS.map((extensionManifest) => ({
    manifest: extensionManifest,
    activate: () => undefined,
}))

export function createBuiltinHost(
    options: Omit<ExtensionHostOptions, "extensions"> = {},
): ExtensionHost {
    return new ExtensionHost({ ...options, extensions: emptyExtensions })
}

export { ExtensionHost }
