import { ApplicationImpl, type Application } from "../core/app"
import { createBuiltinHost } from "../extensions/builtin"
import type { ExtensionHostOptions } from "../extension-host"

export function createBuiltinApplication(
    options: Omit<ExtensionHostOptions, "extensions"> = {},
): Application {
    return new ApplicationImpl(createBuiltinHost(options))
}
