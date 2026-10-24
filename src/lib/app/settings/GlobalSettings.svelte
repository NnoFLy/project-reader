<script lang="ts">
    import { onDestroy, onMount, tick } from "svelte"
    import type { ExtensionHost } from "$lib/extension-host"
    import type { HostSettingsCatalog, SettingCategory } from "$lib/extension-api"
    import Modal from "$lib/shared/ui/modal/Modal.svelte"
    import * as m from "$lib/paraglide/messages"
    import { SettingsModel, settingText } from "./settingsModel.svelte"

    let {
        host,
        onClose,
        whenCommandsSettled = async () => {},
        canDismiss = () => true,
    }: {
        host: Pick<ExtensionHost, "settings"> | { settings: HostSettingsCatalog }
        onClose: () => void
        whenCommandsSettled?: () => Promise<void>
        canDismiss?: () => boolean
    } = $props()
    let model = $state.raw<SettingsModel>()
    let selected = $state("general")
    let page = $state(false)
    let expanded = $state(false)
    let query = $state("")
    let confirming = $state(false)
    let closing = $state(false)
    let search: HTMLInputElement | undefined
    let alive = true
    let navigation: (() => void) | undefined
    const uid = $props.id()
    const categories = ["general", "appearance", "reading", "library"] as const
    const titles: Record<SettingCategory, () => string> = {
        general: m.settings_general,
        appearance: m.settings_appearance,
        reading: m.settings_reading,
        library: m.settings_library,
        plugins: m.settings_plugins,
    }
    onMount(() => {
        model = new SettingsModel(host.settings)
        return () => model?.dispose()
    })
    let fields = $derived(model?.fields ?? [])
    let plugins = $derived([
        ...new Map(
            fields
                .filter(({ entry }) => entry.category === "plugins")
                .map(({ entry }) => [entry.extensionId, entry.extensionName]),
        ).entries(),
    ])
    let location = $derived(
        selected.startsWith("plugin:") && !plugins.some(([id]) => selected === `plugin:${id}`)
            ? "plugins"
            : selected,
    )
    let searching = $derived(Boolean(query.trim()))
    let visible = $derived(
        fields.filter(({ entry }) =>
            searching
                ? `${settingText(entry.label)} ${settingText(entry.description)} ${entry.extensionName}`
                      .toLocaleLowerCase()
                      .includes(query.trim().toLocaleLowerCase())
                : location.startsWith("plugin:")
                  ? entry.category === "plugins" && location === `plugin:${entry.extensionId}`
                  : entry.category === location && location !== "plugins",
        ),
    )
    function select(value: string) {
        selected = value
        page = true
        query = ""
        void tick().then(() => document.getElementById(`${uid}-page`)?.focus())
    }
    export function focus() {
        if (confirming)
            document
                .querySelector<HTMLElement>(`[aria-labelledby="${uid}-confirm-title"] button`)
                ?.focus()
        else search?.focus()
    }
    export function requestNavigation(navigate: (() => void) | undefined) {
        navigation = navigate
        if (navigate) void requestClose(true)
    }
    async function settleWrites() {
        await whenCommandsSettled()
        // Include writes admitted outside this modal, across every setting key.
        await Promise.allSettled(
            host.settings.list().map((entry) => host.settings.getValue(entry.id, entry)),
        )
        await model?.whenSettled()
    }
    function dismiss() {
        if (!alive || !canDismiss()) return
        const navigate = navigation
        navigation = undefined
        onClose()
        navigate?.()
    }
    export async function requestClose(navigationOnly = false) {
        if (closing || confirming || !alive) return
        closing = true
        await settleWrites()
        if (!alive) return
        closing = false
        if (!canDismiss() || (navigationOnly && !navigation)) return
        if (model?.unsaved) confirming = true
        else dismiss()
    }
    function captureSearch(node: HTMLInputElement) {
        search = node
        return () => {
            search = undefined
        }
    }
    function clear() {
        query = ""
        search?.focus()
    }
    function focusNavigation(shell: Element) {
        const target =
            shell.querySelector<HTMLButtonElement>("nav button[aria-current]") ??
            shell.querySelector<HTMLButtonElement>("nav button[aria-expanded]")
        target?.focus()
    }
    async function recoverHiddenFocus(shell: Element, target: Element | null) {
        // Follow rendered custom-media visibility, including phone landscape, without a second breakpoint.
        if (!target || !shell.contains(target) || target.getClientRects().length) return
        const pane = target.closest("nav, section")
        if (
            getComputedStyle(target).display !== "none" &&
            (!pane || getComputedStyle(pane).display !== "none")
        )
            return
        await tick()
        if (
            !alive ||
            confirming ||
            !canDismiss() ||
            shell.closest("[inert]") ||
            !target.isConnected ||
            target.getClientRects().length ||
            (document.activeElement !== target && document.activeElement !== document.body)
        )
            return
        if (shell.querySelector("section")?.getClientRects().length)
            document.getElementById(`${uid}-page`)?.focus()
        else focusNavigation(shell)
    }
    function keepFocusVisible(shell: HTMLElement) {
        const onFocusOut = (event: FocusEvent) => {
            if (event.target instanceof Element) void recoverHiddenFocus(shell, event.target)
        }
        shell.addEventListener("focusout", onFocusOut)
        return () => shell.removeEventListener("focusout", onFocusOut)
    }
    function onResize() {
        const shell = search?.closest(".settings-shell")
        if (shell) void recoverHiddenFocus(shell, document.activeElement)
    }
    async function back(event: MouseEvent) {
        const button = event.currentTarget
        page = false
        query = ""
        await tick()
        if (
            !alive ||
            confirming ||
            !canDismiss() ||
            search?.closest("[inert]") ||
            (document.activeElement !== button && document.activeElement !== document.body)
        )
            return
        const shell = search?.closest(".settings-shell")
        if (shell) focusNavigation(shell)
    }
    onDestroy(() => {
        alive = false
        navigation = undefined
    })
</script>

<svelte:window onresize={onResize} />

<Modal
    title={m.settings()}
    closeLabel={m.settings_close()}
    size="large"
    mobilePresentation="fullscreen"
    closeOnBackdrop={true}
    onClose={() => void requestClose()}
    initialFocus={() => search ?? null}
>
    <div class="settings-shell" aria-busy={closing} {@attach keepFocusVisible}>
        <div class="search">
            <label for={`${uid}-search`}>{m.settings_search()}</label>
            <input
                id={`${uid}-search`}
                type="search"
                {@attach captureSearch}
                bind:value={query}
                disabled={closing || confirming}
            />
            {#if query}<button onclick={clear}>{m.settings_clear_search()}</button>{/if}
        </div>
        {#if model?.lostDraft}<p role="alert">{m.settings_lost_draft()}</p>{/if}
        <div class="settings-grid" class:show-page={page || searching}>
            <nav aria-label={m.settings()}>
                <ul>
                    {#each categories as category (category)}<li>
                            <button
                                aria-current={location === category ? "page" : undefined}
                                onclick={() => select(category)}>{titles[category]()}</button
                            >
                        </li>{/each}
                    <li>
                        <button
                            aria-expanded={expanded}
                            onclick={() => {
                                expanded = !expanded
                                select("plugins")
                            }}>{m.settings_plugins()}</button
                        >
                        {#if expanded}<ul>
                                {#each plugins as [id, name] (id)}<li>
                                        <button
                                            aria-current={location === `plugin:${id}`
                                                ? "page"
                                                : undefined}
                                            onclick={() => select(`plugin:${id}`)}>{name}</button
                                        >
                                    </li>{/each}
                            </ul>{/if}
                    </li>
                </ul>
            </nav>
            <section
                aria-label={searching
                    ? m.settings_search()
                    : location.startsWith("plugin:")
                      ? plugins.find(([id]) => location === `plugin:${id}`)?.[1]
                      : titles[location as SettingCategory]()}
            >
                <button class="back" onclick={back}>{m.settings_back()}</button>
                <h3 id={`${uid}-page`} tabindex="-1">
                    {searching
                        ? m.settings_search()
                        : location.startsWith("plugin:")
                          ? plugins.find(([id]) => location === `plugin:${id}`)?.[1]
                          : titles[location as SettingCategory]()}
                </h3>
                {#each visible as field (field.entry)}
                    {@const entry = field.entry}
                    {@const editor = entry.editor}
                    {@const id = `${uid}-${entry.id}`}
                    {@const error =
                        field.error === "read"
                            ? m.settings_read_failed()
                            : field.error === "invalid"
                              ? m.settings_invalid()
                              : field.error === "save"
                                ? m.settings_not_saved()
                                : ""}
                    <article aria-label={settingText(entry.label)}>
                        {#if searching}<p>
                                {titles[entry.category]()}
                                {entry.category === "plugins" ? `› ${entry.extensionName}` : ""}
                            </p>{/if}
                        {#if entry.group}<p>{settingText(entry.group)}</p>{/if}
                        <label for={id}>{settingText(entry.label)}</label>
                        {#if entry.description}<p id={`${id}-description`}>
                                {settingText(entry.description)}
                            </p>{/if}
                        {#if entry.editorUnavailableReason || !editor}
                            <p>{m.settings_unavailable()}</p>
                        {:else if field.loaded}
                            <fieldset disabled={closing || confirming}>
                                {#if editor.kind === "boolean"}
                                    <input
                                        {id}
                                        type="checkbox"
                                        checked={field.draft === true}
                                        aria-describedby={`${id}-description ${id}-error`}
                                        aria-invalid={Boolean(error)}
                                        onchange={(event) => {
                                            model!.edit(field, event.currentTarget.checked)
                                            model!.commit(field)
                                        }}
                                    />
                                {:else if editor.kind === "choice"}
                                    <select
                                        {id}
                                        value={editor.choices.findIndex((choice) =>
                                            Object.is(choice.value, field.draft),
                                        )}
                                        aria-describedby={`${id}-description ${id}-error`}
                                        aria-invalid={Boolean(error)}
                                        onchange={(event) => {
                                            const choice =
                                                editor.choices[Number(event.currentTarget.value)]
                                            model!.edit(field, choice?.value)
                                            model!.commit(field)
                                        }}
                                    >
                                        {#each editor.choices as choice, index (index)}<option
                                                value={index}>{settingText(choice.label)}</option
                                            >{/each}
                                    </select>
                                {:else if editor.kind === "text"}
                                    <input
                                        {id}
                                        type="text"
                                        value={String(field.draft ?? "")}
                                        minlength={editor.minLength}
                                        maxlength={editor.maxLength}
                                        aria-describedby={`${id}-description ${id}-error`}
                                        aria-invalid={Boolean(error)}
                                        oninput={(event) =>
                                            model!.edit(field, event.currentTarget.value)}
                                        onchange={() => model!.commit(field)}
                                    />
                                {:else if editor.kind === "number"}
                                    <input
                                        {id}
                                        type="number"
                                        value={typeof field.draft === "number" ? field.draft : ""}
                                        min={editor.min}
                                        max={editor.max}
                                        step={editor.step ?? "any"}
                                        aria-describedby={`${id}-description ${id}-error`}
                                        aria-invalid={Boolean(error)}
                                        oninput={(event) =>
                                            model!.edit(
                                                field,
                                                event.currentTarget.value === ""
                                                    ? undefined
                                                    : event.currentTarget.valueAsNumber,
                                            )}
                                        onchange={() => model!.commit(field)}
                                    />
                                {/if}
                                <button onclick={() => model!.reset(field)}
                                    >{m.settings_reset()}</button
                                >
                            </fieldset>
                            {#if !Object.is(field.saved, entry.defaultValue)}<span
                                    >{m.settings_modified()}</span
                                >{/if}
                        {/if}
                        {#if field.reading}<p role="status">{m.settings_loading()}</p>{/if}
                        {#if field.pending}<p role="status">{m.settings_pending()}</p>{/if}
                        <p id={`${id}-error`} role={error ? "alert" : undefined}>{error}</p>
                        {#if field.error === "read" || field.error === "save"}<button
                                disabled={closing || confirming || field.reading}
                                onclick={() =>
                                    field.error === "read"
                                        ? void model!.read(field)
                                        : model!.commit(field)}>{m.settings_retry()}</button
                            >{/if}
                    </article>
                {:else}
                    <p role="status">
                        {searching
                            ? m.settings_no_results()
                            : location === "plugins" && !plugins.length
                              ? m.settings_no_plugins()
                              : ""}
                    </p>
                {/each}
                {#if location === "plugins" && !searching && plugins.length}<ul>
                        {#each plugins as [id, name] (id)}<li>
                                <button onclick={() => select(`plugin:${id}`)}>{name}</button>
                            </li>{/each}
                    </ul>{/if}
            </section>
        </div>
    </div>
</Modal>
{#if confirming}
    <Modal
        id={`${uid}-confirm`}
        variant="confirmation"
        title={m.settings_unsaved_title()}
        message={m.settings_unsaved_message()}
        confirmLabel={m.settings_discard()}
        cancelLabel={m.settings_stay()}
        onConfirm={() => {}}
        onClose={async (reason) => {
            if (!alive) return
            confirming = false
            if (reason !== "confirmed") return
            // Restore focus from the confirmation into Settings before removing Settings.
            closing = true
            await tick()
            await settleWrites()
            closing = false
            dismiss()
        }}
    />
{/if}

<style>
    .settings-shell {
        display: flex;
        flex-direction: column;
        min-height: 0;
        flex: 1;
    }
    .search {
        display: flex;
        align-items: center;
        flex-wrap: wrap;
        gap: 12px;
        padding: 16px;
        border-bottom: 2px solid var(--border-color);
    }
    .search input {
        flex: 1;
        min-width: 10rem;
    }
    .settings-grid {
        display: grid;
        grid-template-columns: minmax(11rem, 15rem) minmax(0, 1fr);
        flex: 1;
        min-height: 0;
    }
    nav,
    section {
        overflow-y: auto;
        overscroll-behavior: contain;
        min-width: 0;
        padding: 16px;
    }
    nav {
        border-right: 2px solid var(--border-color);
        background: var(--bg-color);
    }
    ul {
        list-style: none;
        padding-left: 12px;
    }
    nav > ul {
        padding: 0;
    }
    nav button {
        width: 100%;
        text-align: start;
    }
    button,
    input,
    select {
        font: inherit;
        color: var(--text-color);
        background: var(--surface-color);
        border: 2px solid var(--border-color);
        border-radius: var(--radius-sm);
        padding: 8px 12px;
        max-width: 100%;
    }
    button {
        cursor: pointer;
        min-height: 44px;
        overflow-wrap: anywhere;
    }
    button[aria-current] {
        border-color: var(--accent-color);
    }
    :is(button, input, select):focus-visible {
        outline: 3px solid var(--accent-color);
        outline-offset: 2px;
    }
    article {
        padding-block: 16px;
        border-bottom: 1px solid var(--border-color);
        overflow-wrap: anywhere;
    }
    label {
        font-weight: 600;
    }
    p {
        line-height: 1.5;
        overflow-wrap: anywhere;
    }
    fieldset {
        display: flex;
        align-items: center;
        flex-wrap: wrap;
        gap: 12px;
        padding: 12px 0;
        border: 0;
        min-width: 0;
    }
    input[type="checkbox"] {
        width: 24px;
        height: 24px;
        accent-color: var(--accent-color);
    }
    [aria-invalid="true"] {
        border-color: var(--danger-color);
    }
    .back {
        display: none;
    }
    @media (--mobile) {
        .settings-grid {
            grid-template-columns: minmax(0, 1fr);
        }
        .settings-grid:not(.show-page) section,
        .show-page nav {
            display: none;
        }
        .back {
            display: inline-block;
        }
        nav,
        section {
            padding-inline: max(16px, env(safe-area-inset-left))
                max(16px, env(safe-area-inset-right));
            padding-bottom: calc(16px + env(safe-area-inset-bottom));
        }
    }
</style>
