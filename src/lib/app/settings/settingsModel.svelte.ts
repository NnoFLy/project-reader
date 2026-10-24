import type { HostSettingsCatalog, RegisteredSetting, SettingText } from "$lib/extension-api"

export function settingText(text: SettingText | undefined): string {
    try {
        return typeof text === "function" ? text() : (text ?? "")
    } catch {
        return ""
    }
}

export class SettingField {
    readonly entry: RegisteredSetting
    saved = $state<unknown>(undefined)
    draft = $state<unknown>(undefined)
    loaded = $state(false)
    reading = $state(false)
    dirty = $state(false)
    pending = $state(0)
    error = $state<"" | "read" | "invalid" | "save">("")
    revision = 0
    readRevision = 0
    resetAttempt = false
    constructor(entry: RegisteredSetting) {
        this.entry = entry
    }
}

export class SettingsModel {
    fields = $state.raw<SettingField[]>([])
    lostDraft = $state(false)
    private active = true
    private catalog: HostSettingsCatalog
    private operations: Promise<void>[] = []
    private subscription: ReturnType<HostSettingsCatalog["onDidChange"]>
    constructor(catalog: HostSettingsCatalog) {
        this.catalog = catalog
        this.subscription = catalog.onDidChange((change) => {
            if (!this.active) return
            if (change.kind === "catalog") this.refresh()
            else {
                const field = this.fields.find(({ entry }) => entry.id === change.settingId)
                if (!field || !this.current(field)) return
                field.readRevision++
                field.saved = change.value
                field.loaded = true
                field.reading = false
                if (!field.dirty && !field.pending) {
                    field.draft = change.value
                    field.error = ""
                }
            }
        })
        this.refresh()
    }
    private current(field: SettingField) {
        return (
            this.active &&
            this.catalog.get(field.entry.id) === field.entry &&
            this.fields.includes(field)
        )
    }
    private refresh() {
        const entries = this.catalog.list()
        for (const field of this.fields) {
            if (!entries.includes(field.entry) && (field.dirty || field.pending))
                this.lostDraft = true
        }
        const previous = this.fields
        this.fields = entries.map(
            (entry) => previous.find((field) => field.entry === entry) ?? new SettingField(entry),
        )
        for (const field of this.fields) if (!previous.includes(field)) void this.read(field)
    }
    async read(field: SettingField) {
        if (!this.current(field)) return
        const readRevision = ++field.readRevision
        const revision = field.revision
        field.reading = true
        field.error = ""
        try {
            const value = await this.catalog.getValue(field.entry.id, field.entry)
            if (!this.current(field) || readRevision !== field.readRevision) return
            field.saved = value
            field.loaded = true
            if (revision === field.revision && !field.dirty) field.draft = value
        } catch {
            if (this.current(field) && readRevision === field.readRevision) field.error = "read"
        } finally {
            if (this.current(field) && readRevision === field.readRevision) field.reading = false
        }
    }
    edit(field: SettingField, draft: unknown) {
        if (!this.current(field) || !field.loaded) return
        field.revision++
        field.draft = draft
        field.dirty = true
        field.resetAttempt = false
        field.error = this.valid(field, draft) ? "" : "invalid"
    }
    private valid(field: SettingField, value: unknown): boolean {
        const editor = field.entry.editor
        if (!editor || field.entry.editorUnavailableReason) return false
        try {
            if (editor.kind === "boolean" && typeof value !== "boolean") return false
            if (
                editor.kind === "choice" &&
                !editor.choices.some((choice) => Object.is(choice.value, value))
            )
                return false
            if (
                editor.kind === "text" &&
                (typeof value !== "string" ||
                    value.length < (editor.minLength ?? 0) ||
                    value.length > (editor.maxLength ?? Infinity))
            )
                return false
            if (editor.kind === "number") {
                if (
                    typeof value !== "number" ||
                    !Number.isFinite(value) ||
                    value < (editor.min ?? -Infinity) ||
                    value > (editor.max ?? Infinity)
                )
                    return false
                if (editor.step) {
                    const steps = (value - (editor.min ?? 0)) / editor.step
                    if (Math.abs(steps - Math.round(steps)) > 1e-9) return false
                }
            }
            return !field.entry.validate || field.entry.validate(value)
        } catch {
            return false
        }
    }
    reset(field: SettingField) {
        this.edit(field, field.entry.defaultValue)
        field.resetAttempt = true
        this.commit(field)
    }
    commit(field: SettingField) {
        if (!this.current(field) || !field.loaded || !field.dirty || field.error === "invalid")
            return
        const revision = ++field.revision
        const value = field.draft
        const reset = field.resetAttempt
        field.error = ""
        field.pending++
        const operation = (async () => {
            try {
                if (reset) await this.catalog.resetValue(field.entry.id, field.entry)
                else await this.catalog.setValue(field.entry.id, value, field.entry)
                if (!this.current(field) || revision !== field.revision) return
                // Value notifications precede completion and are authoritative, not this draft.
                field.dirty = false
                field.draft = field.saved
                field.error = ""
            } catch {
                if (this.current(field) && revision === field.revision) field.error = "save"
            } finally {
                if (this.current(field)) field.pending--
            }
        })()
        this.operations.push(operation)
        void operation.then(() => {
            this.operations = this.operations.filter((pending) => pending !== operation)
        })
    }
    async whenSettled() {
        while (this.operations.length) await Promise.all(this.operations)
    }
    get unsaved() {
        return this.fields.some((field) => field.dirty)
    }
    dispose() {
        this.active = false
        void this.subscription.dispose()
    }
}
