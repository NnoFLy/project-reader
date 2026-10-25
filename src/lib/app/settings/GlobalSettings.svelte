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
    const categories = ["general", "appearance", "library"] as const
    const readingPage = "category:reading"
    // Keep presentation local: app-host cannot depend on the shared icon layer.
    const iconPaths = {
        general: "M4 7h9m4 0h3M4 17h3m4 0h9M13 4v6M7 14v6",
        appearance:
            "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8ZM12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5",
        library: "M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z",
        plugins: "m4 6 6 6-6 6m9 0h7",
        search: "M21 21l-5-5m-6 2a8 8 0 1 0 0-16 8 8 0 0 0 0 16Z",
        close: "m6 6 12 12M6 18 18 6",
        chevron: "m6 9 6 6 6-6",
    }
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
        // Group existing Reading preferences here without changing their owners or durable IDs.
        ...(fields.some(({ entry }) => entry.category === "reading")
            ? [[readingPage, m.settings_reading()] as const]
            : []),
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
                ? `${settingText(entry.label)} ${settingText(entry.description)} ${entry.extensionName} ${titles[entry.category]()}`
                      .toLocaleLowerCase()
                      .includes(query.trim().toLocaleLowerCase())
                : location === `plugin:${readingPage}`
                  ? entry.category === "reading"
                  : location.startsWith("plugin:")
                    ? entry.category === "plugins" && location === `plugin:${entry.extensionId}`
                    : entry.category === location && location !== "plugins",
        ),
    )
    function select(value: string) {
        selected = value
        if (value.startsWith("plugin:")) expanded = true
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

{#snippet icon(name: keyof typeof iconPaths)}
    <svg
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.75"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
    >
        <path d={iconPaths[name]} />
    </svg>
{/snippet}

<svelte:window onresize={onResize} />

<Modal
    title={m.settings()}
    closeLabel={m.settings_close()}
    size="large"
    draggable
    mobilePresentation="fullscreen"
    closeOnBackdrop={true}
    onClose={() => void requestClose()}
    initialFocus={() => search ?? null}
>
    <div class="settings-shell" aria-busy={closing} {@attach keepFocusVisible}>
        <div class="search">
            <label class="visually-hidden" for={`${uid}-search`}>{m.settings_search()}</label>
            {@render icon("search")}
            <input
                id={`${uid}-search`}
                type="search"
                placeholder={m.settings_search()}
                {@attach captureSearch}
                bind:value={query}
                disabled={closing || confirming}
            />
            {#if query}
                <button class="clear-search" onclick={clear} aria-label={m.settings_clear_search()}>
                    {@render icon("close")}
                    <span class="visually-hidden">{m.settings_clear_search()}</span>
                </button>
            {/if}
        </div>
        {#if model?.lostDraft}<p class="draft-alert" role="alert">{m.settings_lost_draft()}</p>{/if}
        <div class="settings-grid" class:show-page={page || searching}>
            <nav aria-label={m.settings()}>
                <ul>
                    {#each categories as category (category)}
                        <li>
                            <button
                                aria-current={!searching && location === category
                                    ? "page"
                                    : undefined}
                                onclick={() => select(category)}
                            >
                                {@render icon(category)}
                                <span>{titles[category]()}</span>
                                <span class="nav-chevron">{@render icon("chevron")}</span>
                            </button>
                        </li>
                    {/each}
                    <li>
                        <button
                            aria-expanded={expanded}
                            aria-current={!searching && location === "plugins" ? "page" : undefined}
                            onclick={() => {
                                expanded = !expanded
                                select("plugins")
                            }}
                        >
                            {@render icon("plugins")}
                            <span>{m.settings_plugins()}</span>
                            <span class="plugin-chevron" class:expanded>
                                {@render icon("chevron")}
                            </span>
                        </button>
                        {#if expanded}<ul class="plugin-navigation">
                                {#each plugins as [id, name] (id)}<li>
                                        <button
                                            aria-current={!searching && location === `plugin:${id}`
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
                <button class="back" onclick={back}>
                    {@render icon("chevron")}{m.settings_back()}
                </button>
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
                        <div class="setting-info">
                            {#if searching}<p class="setting-context">
                                    {entry.category === "reading"
                                        ? `${m.settings_plugins()} › ${m.settings_reading()}`
                                        : titles[entry.category]()}
                                    {entry.category === "plugins" ? `› ${entry.extensionName}` : ""}
                                </p>{/if}
                            {#if entry.group}<p class="setting-context">
                                    {settingText(entry.group)}
                                </p>{/if}
                            <label for={id}>{settingText(entry.label)}</label>
                            {#if entry.description}<p
                                    class="setting-description"
                                    id={`${id}-description`}
                                >
                                    {settingText(entry.description)}
                                </p>{/if}
                        </div>
                        {#if entry.editorUnavailableReason || !editor}
                            <p class="setting-status">{m.settings_unavailable()}</p>
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
                                <button class="reset" onclick={() => model!.reset(field)}
                                    >{m.settings_reset()}</button
                                >
                            </fieldset>
                            {#if !Object.is(field.saved, entry.defaultValue)}<span class="modified"
                                    >{m.settings_modified()}</span
                                >{/if}
                        {/if}
                        {#if field.reading}<p class="setting-status" role="status">
                                {m.settings_loading()}
                            </p>{/if}
                        {#if field.pending}<p class="setting-status" role="status">
                                {m.settings_pending()}
                            </p>{/if}
                        <p
                            class="setting-error"
                            id={`${id}-error`}
                            role={error ? "alert" : undefined}
                        >
                            {error}
                        </p>
                        {#if field.error === "read" || field.error === "save"}<button
                                disabled={closing || confirming || field.reading}
                                onclick={() =>
                                    field.error === "read"
                                        ? void model!.read(field)
                                        : model!.commit(field)}>{m.settings_retry()}</button
                            >{/if}
                    </article>
                {:else}
                    <p class="empty-state" role="status">
                        {searching
                            ? m.settings_no_results()
                            : location === "plugins" && !plugins.length
                              ? m.settings_no_plugins()
                              : ""}
                    </p>
                {/each}
                {#if location === "plugins" && !searching && plugins.length}<ul class="plugin-list">
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

    button,
    input,
    select {
        box-sizing: border-box;
        max-width: 100%;
        font: inherit;
        color: var(--text-color);
    }

    button {
        min-height: var(--control-height-compact);
        padding: var(--space-2) var(--space-3);
        border: 1px solid transparent;
        border-radius: var(--radius-sm);
        background: transparent;
        text-align: start;
        cursor: pointer;
        overflow-wrap: anywhere;
        transition: background-color var(--motion-duration-fast) ease;
    }

    :is(button, input, select):focus-visible {
        outline: 2px solid var(--focus-color);
        outline-offset: 2px;
    }

    :is(button, input, select):disabled,
    fieldset:disabled {
        opacity: 0.55;
        cursor: not-allowed;
    }

    .search {
        display: flex;
        align-items: center;
        gap: var(--space-3);
        min-height: 60px;
        padding: var(--space-2) var(--space-5);
        border-bottom: 1px solid var(--border-color);
    }

    .search :global(svg) {
        flex: 0 0 auto;
        width: 18px;
        height: 18px;
        color: var(--faded-text-color);
        stroke-width: 1.75;
    }

    .search input {
        flex: 1;
        min-width: 0;
        width: 100%;
        min-height: var(--control-height-regular);
        padding: var(--space-2);
        border: 0;
        border-radius: var(--radius-sm);
        background: transparent;
        font-size: var(--font-size-input);
    }

    .search input::placeholder {
        color: var(--faded-text-color);
        opacity: 1;
    }

    .search input::-webkit-search-cancel-button {
        appearance: none;
    }

    .clear-search {
        display: grid;
        place-items: center;
        flex: 0 0 auto;
        width: var(--control-height-regular);
        min-height: var(--control-height-regular);
        padding: 0;
        border-radius: var(--radius-full);
    }

    .settings-grid {
        display: grid;
        grid-template-columns: 13.5rem minmax(0, 1fr);
        flex: 1;
        min-height: 0;
    }

    nav,
    section {
        overflow-y: auto;
        overscroll-behavior: contain;
        scrollbar-width: thin;
        min-width: 0;
    }

    nav {
        padding: var(--space-4) var(--space-3);
        border-right: 1px solid var(--border-color);
        background: var(--bg-color);
    }

    ul {
        margin: 0;
        padding: 0;
        list-style: none;
    }

    nav > ul {
        display: grid;
        gap: var(--space-1);
    }

    nav button {
        display: flex;
        align-items: center;
        gap: var(--space-3);
        width: 100%;
        min-height: var(--control-height-regular);
        color: var(--faded-text-color);
    }

    nav button > span:not(.nav-chevron, .plugin-chevron) {
        flex: 1;
        min-width: 0;
    }

    nav :global(svg),
    .back :global(svg) {
        flex: 0 0 auto;
        width: 18px;
        height: 18px;
        stroke-width: 1.75;
    }

    nav button[aria-current] {
        color: var(--active-text-color);
        background: var(--active-color);
        font-weight: 600;
    }

    .nav-chevron,
    .plugin-chevron {
        display: flex;
    }

    .nav-chevron {
        display: none;
        transform: rotate(-90deg);
    }

    .plugin-chevron {
        transition: transform var(--motion-duration-fast) ease;
    }

    .plugin-chevron.expanded {
        transform: rotate(180deg);
    }

    .plugin-navigation {
        margin: var(--space-1) 0 var(--space-2) var(--space-5);
        padding-left: var(--space-2);
        border-left: 1px solid var(--border-color);
    }

    section {
        padding: var(--space-5) var(--space-6);
        scroll-padding-block: var(--space-5);
    }

    h3 {
        margin: 0 0 var(--space-2);
        font-size: var(--font-size-xl);
        font-weight: 600;
        letter-spacing: -0.02em;
        overflow-wrap: anywhere;
    }

    article {
        display: grid;
        grid-template-columns: minmax(0, 1fr) minmax(11rem, 14rem);
        align-items: start;
        column-gap: var(--space-5);
        row-gap: var(--space-2);
        padding-block: var(--space-5);
        border-bottom: 1px solid var(--border-color);
        overflow-wrap: anywhere;
    }

    .setting-info {
        min-width: 0;
        padding-top: var(--space-2);
    }

    label {
        font-weight: 600;
    }

    p {
        margin: 0;
        line-height: 1.5;
    }

    .setting-description {
        margin-top: var(--space-1);
        color: var(--faded-text-color);
        font-size: var(--font-size-sm);
    }

    .setting-context {
        margin-bottom: var(--space-2);
        color: var(--faded-text-color);
        font-size: var(--font-size-xs);
    }

    fieldset {
        display: flex;
        flex-direction: column;
        align-items: flex-end;
        gap: var(--space-1);
        min-width: 0;
        margin: 0;
        padding: 0;
        border: 0;
    }

    fieldset :is(input:not([type="checkbox"]), select) {
        width: 100%;
        min-height: var(--control-height-regular);
        padding: var(--space-2) var(--space-3);
        border: 1px solid var(--color-control-border);
        border-radius: var(--radius-sm);
        background: var(--surface-color);
        font-size: var(--font-size-input);
    }

    input[type="checkbox"] {
        appearance: none;
        flex: 0 0 auto;
        width: 44px;
        height: 24px;
        margin: 10px 0;
        padding: 3px;
        border: 1px solid var(--color-control-border);
        border-radius: 999px;
        background: var(--bg-color);
        cursor: pointer;
        transition: background-color var(--motion-duration-fast) ease;
    }

    input[type="checkbox"]::before {
        content: "";
        display: block;
        width: 16px;
        height: 16px;
        border-radius: var(--radius-full);
        background: var(--faded-text-color);
        transition: transform var(--motion-duration-fast) ease;
    }

    input[type="checkbox"]:checked {
        border-color: var(--primary-color);
        background: var(--primary-color);
    }

    input[type="checkbox"]:checked::before {
        transform: translateX(18px);
        background: var(--primary-text-color);
    }

    .reset {
        max-width: 100%;
        padding: var(--space-1) var(--space-2);
        color: var(--faded-text-color);
        font-size: var(--font-size-xs);
        text-align: end;
    }

    .modified,
    .setting-status,
    .setting-error {
        grid-column: 1 / -1;
        font-size: var(--font-size-xs);
        color: var(--faded-text-color);
    }

    .modified {
        display: flex;
        align-items: center;
        gap: var(--space-2);
    }

    .modified::before {
        content: "";
        width: 5px;
        height: 5px;
        border-radius: var(--radius-full);
        background: currentColor;
    }

    .setting-error {
        color: var(--danger-color);
    }

    .setting-error:empty,
    .empty-state:empty {
        display: none;
    }

    [aria-invalid="true"] {
        border-color: var(--danger-color);
    }

    .draft-alert {
        margin: var(--space-3) var(--space-5) 0;
        color: var(--danger-color);
    }

    .empty-state {
        padding-block: var(--space-5);
        color: var(--faded-text-color);
    }

    .plugin-list {
        margin-top: var(--space-4);
    }

    .plugin-list button {
        width: 100%;
        min-height: var(--control-height-regular);
        border-bottom-color: var(--border-color);
    }

    .back {
        display: none;
    }

    .visually-hidden {
        position: absolute;
        width: 1px;
        height: 1px;
        padding: 0;
        margin: -1px;
        overflow: hidden;
        clip-path: inset(50%);
        white-space: nowrap;
        border: 0;
    }

    @media (hover: hover) {
        button:hover:not(:disabled, [aria-current]) {
            background: var(--surface-hover-color);
            color: var(--text-color);
        }
    }

    @media (forced-colors: active) {
        input[type="checkbox"] {
            appearance: auto;
            accent-color: auto;
        }

        input[type="checkbox"]::before {
            display: none;
        }

        nav button[aria-current] {
            outline: 1px solid Highlight;
            outline-offset: -1px;
        }
    }

    @media (--mobile) {
        .search {
            padding-inline: max(var(--space-4), env(safe-area-inset-left))
                max(var(--space-4), env(safe-area-inset-right));
        }

        .settings-grid {
            grid-template-columns: minmax(0, 1fr);
        }

        .settings-grid:not(.show-page) section,
        .show-page nav {
            display: none;
        }

        nav {
            border-right: 0;
        }

        nav,
        section {
            padding-inline: max(var(--space-4), env(safe-area-inset-left))
                max(var(--space-4), env(safe-area-inset-right));
            padding-bottom: calc(var(--space-5) + env(safe-area-inset-bottom));
        }

        .nav-chevron {
            display: flex;
        }

        .back {
            display: inline-flex;
            align-items: center;
            gap: var(--space-2);
            min-height: var(--control-height-regular);
            margin: calc(-1 * var(--space-2)) 0 var(--space-3);
            padding-inline: 0 var(--space-3);
            color: var(--faded-text-color);
        }

        .back :global(svg) {
            transform: rotate(90deg);
        }

        article {
            grid-template-columns: minmax(0, 1fr);
            row-gap: var(--space-3);
        }

        .setting-info {
            padding-top: 0;
        }

        fieldset {
            flex-direction: row;
            flex-wrap: wrap;
            align-items: center;
            justify-content: space-between;
            gap: var(--space-2) var(--space-3);
        }

        fieldset :is(input:not([type="checkbox"]), select) {
            flex: 1 1 10rem;
            width: auto;
            min-width: 0;
        }

        .reset {
            min-height: var(--control-height-regular);
        }
    }
</style>
