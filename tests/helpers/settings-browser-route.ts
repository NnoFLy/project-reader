import { createRawSnippet, mount, unmount } from "svelte"
import AppChrome from "../../src/lib/app/AppChrome.svelte"
import { APP_HOST_CONTEXT } from "../../src/lib/app/hostContext"
import { ApplicationImpl } from "../../src/lib/core/app/application"
import { IndexedDBStorageBackend } from "../../src/lib/core/storage"
import { ExtensionHost } from "../../src/lib/extension-host"
import { BUILTIN_MANIFESTS } from "../../src/lib/extensions/builtin"
import { activatePrompt } from "../../src/lib/extensions/builtin/prompt"
import { activateSettings } from "../../src/lib/extensions/builtin/settings"
import type { AppExtension } from "../../src/lib/extension-api"

export const pluginName = "Paper Tools <img src=x onerror=window.metadataExecuted=true>"
export const captionLabel = "Caption <img src=x onerror=window.metadataExecuted=true>"
export const longDescription =
    "Untrusted <script>window.metadataExecuted=true</script> " +
    "Long plugin description with readable wrapping and no executable markup. ".repeat(18)

const plugin: AppExtension = {
    manifest: {
        id: "test.browser-options",
        name: pluginName,
        version: "1.0.0",
        engine: "*",
        entry: "browser-options",
        activationEvents: [{ type: "startup" }],
        permissions: ["settings", "storage"],
    },
    activate(context) {
        context.settings.register({
            id: "test.browser-options.caption",
            label: captionLabel,
            description: longDescription,
            defaultValue: "saved caption",
            editor: { kind: "text", minLength: 2 },
        })
        context.settings.register({
            id: "test.browser-options.count",
            label: "Count",
            description: "Even values from zero to ten",
            defaultValue: 2,
            editor: { kind: "number", min: 0, max: 10, step: 2 },
        })
        context.settings.register({
            id: "test.browser-options.enabled",
            label: "Enabled",
            defaultValue: false,
            editor: { kind: "boolean" },
        })
        context.settings.register({
            id: "test.browser-options.mode",
            label: "Mode",
            defaultValue: "one",
            editor: {
                kind: "choice",
                choices: [
                    { value: "one", label: "<img src=x onerror=window.metadataExecuted=true>" },
                    { value: "two", label: "Two" },
                ],
            },
        })
    },
}

// Keep AppChrome, mount and builtin activators in one statically resolved Svelte runtime,
// as in reading-provider-route.ts. No fake host, settings model or modal policy.
export async function mountSettingsBrowserRoute(
    target: HTMLElement,
    databaseName = `settings-browser-${crypto.randomUUID()}`,
) {
    const backend = new IndexedDBStorageBackend({ databaseName })
    const host = new ExtensionHost({
        storage: backend,
        extensions: [
            { manifest: BUILTIN_MANIFESTS[1], activate: activatePrompt },
            { manifest: BUILTIN_MANIFESTS[3], activate: activateSettings },
            plugin,
        ],
    })
    const application = new ApplicationImpl(host)
    await application.start()
    const services = { executeCommand: host.commands.execute }
    const component = mount(AppChrome, {
        target,
        context: new Map<unknown, unknown>([
            [APP_HOST_CONTEXT, { application, ready: true, services }],
            ["app-host-services", services],
        ]),
        props: {
            children: createRawSnippet(() => ({
                render: () =>
                    '<main aria-label="Settings browser fixture">Settings browser fixture</main>',
            })),
        },
    })
    return {
        host,
        backend,
        databaseName,
        async stop() {
            await unmount(component)
            await application.stop()
        },
    }
}
