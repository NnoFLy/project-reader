import {
    assertNamespacedId,
    belongsToExtension,
    type Disposable,
    type RegisteredSetting,
    type SettingContribution,
    type SettingsRegistry,
    type SettingsChange,
    type SettingEditor,
    type SettingText,
    type SettingCategory,
} from "../../extension-api"

export interface SettingsStore {
    get<T>(id: string): Promise<T | undefined>
    set<T>(id: string, value: T): Promise<void>
}

/** One ordering boundary per durable setting, retained across registry replacement. */
export class SettingsOperationCoordinator {
    private readonly pending = new Map<string, Promise<void>>()

    run<T>(id: string, operation: () => Promise<T>): Promise<T> {
        const result = (this.pending.get(id) ?? Promise.resolve()).then(operation)
        const settled = result.then(
            () => undefined,
            () => undefined,
        )
        this.pending.set(id, settled)
        void settled.then(() => {
            if (this.pending.get(id) === settled) this.pending.delete(id)
        })
        return result
    }
}

export class SettingsRegistryImpl implements SettingsRegistry {
    private readonly settings = new Map<string, RegisteredSetting>()
    private readonly values = new Map<string, unknown>()
    private disposed = false
    private readonly listeners = new Set<(change: SettingsChange) => void>()

    constructor(
        private readonly extensionId: string,
        private readonly store?: SettingsStore,
        private readonly operations = new SettingsOperationCoordinator(),
        private readonly extensionName = extensionId,
        private readonly placement: (settingId: string) => SettingCategory = () => "plugins",
    ) {}

    register<T>(setting: SettingContribution<T>): Disposable {
        this.assertUsable()
        assertNamespacedId(setting.id, "setting")
        if (!belongsToExtension(setting.id, this.extensionId)) {
            throw new Error(
                `Setting ${setting.id} is outside extension namespace ${this.extensionId}`,
            )
        }
        if (this.settings.has(setting.id))
            throw new Error(`Setting is already registered: ${setting.id}`)
        const editor = normalizeEditor(setting.editor)
        const textValid =
            isText(setting.label) &&
            (setting.description === undefined || isText(setting.description)) &&
            (setting.group === undefined || isText(setting.group))
        const editorUnavailableReason = !textValid
            ? "Invalid editor display metadata"
            : setting.validate !== undefined && typeof setting.validate !== "function"
              ? "Invalid editor validator"
              : !editor
                ? setting.editor === undefined
                    ? "Missing editor metadata"
                    : "Unsupported or invalid editor metadata"
                : !acceptsEditorValue(editor, setting.defaultValue)
                  ? "Invalid editor default value"
                  : undefined
        const registered = Object.freeze({
            ...setting,
            label: safeText(setting.label, setting.id),
            description:
                setting.description === undefined ? undefined : safeText(setting.description, ""),
            group: setting.group === undefined ? undefined : safeText(setting.group, ""),
            editor,
            editorUnavailableReason,
            category: this.placement(setting.id),
            extensionId: this.extensionId,
            extensionName: this.extensionName,
        })
        this.settings.set(setting.id, registered)
        this.emit({ kind: "catalog" })
        let active = true
        return {
            dispose: () => {
                if (!active) return
                active = false
                this.settings.delete(setting.id)
                this.values.delete(setting.id)
                this.emit({ kind: "catalog" })
            },
        }
    }

    get<T = unknown>(settingId: string): RegisteredSetting<T> | undefined {
        return this.settings.get(settingId) as RegisteredSetting<T> | undefined
    }

    list(): readonly RegisteredSetting[] {
        return [...this.settings.values()]
    }

    async getValue<T>(settingId: string): Promise<T> {
        const setting = this.requireSetting(settingId)
        return this.operations.run(settingId, async () => {
            this.assertCurrent(setting)
            const stored = this.store
                ? await this.store.get<T>(settingId)
                : this.values.get(settingId)
            this.assertCurrent(setting)
            return (stored === undefined ? setting.defaultValue : stored) as T
        })
    }

    async setValue<T>(settingId: string, value: T, provenance?: symbol): Promise<void> {
        const setting = this.requireSetting(settingId)
        this.validateValue(setting, value)
        return this.operations.run(settingId, () => this.persistValue(setting, value, provenance))
    }

    async initializeValue<T>(
        settingId: string,
        value: T,
        provenance?: symbol,
    ): Promise<{ readonly initialized: boolean; readonly value: T }> {
        const setting = this.requireSetting(settingId)
        this.validateValue(setting, value)
        return this.operations.run(settingId, async () => {
            this.assertCurrent(setting)
            const stored = this.store
                ? await this.store.get<T>(settingId)
                : this.values.get(settingId)
            this.assertCurrent(setting)
            if (stored !== undefined) return { initialized: false, value: stored as T }
            await this.persistValue(setting, value, provenance)
            return { initialized: true, value }
        })
    }

    private validateValue(setting: RegisteredSetting, value: unknown): void {
        const settingId = setting.id
        if (
            setting.editorUnavailableReason &&
            setting.editorUnavailableReason !== "Missing editor metadata"
        )
            throw new Error(`Setting editor unavailable: ${setting.editorUnavailableReason}`)
        if (setting.editor && !acceptsEditorValue(setting.editor, value))
            throw new Error(`Invalid value for setting: ${settingId}`)
        if (!acceptsDeclaredValue(setting.validate, value))
            throw new Error(`Invalid value for setting: ${settingId}`)
    }

    private async persistValue(
        setting: RegisteredSetting,
        value: unknown,
        provenance?: symbol,
    ): Promise<void> {
        this.assertCurrent(setting)
        if (this.store) await this.store.set(setting.id, value)
        else this.values.set(setting.id, value)
        this.assertCurrent(setting)
        this.emit({
            kind: "value",
            settingId: setting.id,
            value,
            ...(provenance === undefined ? {} : { provenance }),
        })
    }

    private requireSetting(id: string): RegisteredSetting {
        this.assertUsable()
        const setting = this.settings.get(id)
        if (!setting) throw new Error(`Setting is not registered: ${id}`)
        return setting
    }

    private assertCurrent(setting: RegisteredSetting): void {
        this.assertUsable()
        if (this.settings.get(setting.id) !== setting)
            throw new Error(`Setting is no longer registered: ${setting.id}`)
    }

    resetValue(settingId: string): Promise<void> {
        const setting = this.settings.get(settingId)
        if (!setting) return Promise.reject(new Error(`Setting is not registered: ${settingId}`))
        return this.setValue(settingId, setting.defaultValue)
    }

    onDidChange(listener: (change: SettingsChange) => void): Disposable {
        this.assertUsable()
        this.listeners.add(listener)
        return {
            dispose: () => {
                this.listeners.delete(listener)
            },
        }
    }

    private emit(change: SettingsChange): void {
        for (const listener of this.listeners) {
            try {
                listener(change)
            } catch {
                /* Observers cannot undo persistence. */
            }
        }
    }

    dispose(): void {
        this.disposed = true
        this.settings.clear()
        this.values.clear()
        this.emit({ kind: "catalog" })
        this.listeners.clear()
    }

    private assertUsable(): void {
        if (this.disposed) throw new Error(`Settings registry for ${this.extensionId} is disposed`)
    }
}

function isText(value: unknown): value is SettingText {
    return typeof value === "string" || typeof value === "function"
}

function safeText(value: unknown, fallback: string): SettingText {
    if (typeof value === "string") return value
    if (typeof value !== "function") return fallback
    return () => {
        try {
            const text: unknown = value()
            return typeof text === "string" ? text : fallback
        } catch {
            return fallback
        }
    }
}

function normalizeEditor(input: unknown): SettingEditor | undefined {
    if (!input || typeof input !== "object") return undefined
    const editor = input as Record<string, unknown>
    if (editor.kind === "boolean") return Object.freeze({ kind: "boolean" })
    if (editor.kind === "choice") {
        if (!Array.isArray(editor.choices) || !editor.choices.length) return undefined
        const choices: { value: string | number | boolean; label: SettingText }[] = []
        for (const choice of editor.choices) {
            if (
                !choice ||
                typeof choice !== "object" ||
                !isText(choice.label) ||
                !["string", "number", "boolean"].includes(typeof choice.value) ||
                (typeof choice.value === "number" && !Number.isFinite(choice.value)) ||
                choices.some((existing) => existing.value === choice.value)
            )
                return undefined
            choices.push(Object.freeze({ value: choice.value, label: safeText(choice.label, "") }))
        }
        return Object.freeze({ kind: "choice", choices: Object.freeze(choices) })
    }
    if (editor.kind === "number") {
        const { min, max, step } = editor
        if (
            [min, max, step].some(
                (value) =>
                    value !== undefined && (typeof value !== "number" || !Number.isFinite(value)),
            )
        )
            return undefined
        if (typeof min === "number" && typeof max === "number" && min > max) return undefined
        if (typeof step === "number" && step <= 0) return undefined
        return Object.freeze({ kind: "number", min, max, step }) as SettingEditor
    }
    if (editor.kind === "text") {
        const { minLength, maxLength } = editor
        if (
            [minLength, maxLength].some(
                (value) =>
                    value !== undefined &&
                    (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0),
            )
        )
            return undefined
        if (typeof minLength === "number" && typeof maxLength === "number" && minLength > maxLength)
            return undefined
        return Object.freeze({ kind: "text", minLength, maxLength }) as SettingEditor
    }
    return undefined
}

function acceptsEditorValue(editor: SettingEditor, value: unknown): boolean {
    switch (editor.kind) {
        case "boolean":
            return typeof value === "boolean"
        case "choice":
            return editor.choices.some((choice) => choice.value === value)
        case "text":
            return (
                typeof value === "string" &&
                (editor.minLength === undefined || value.length >= editor.minLength) &&
                (editor.maxLength === undefined || value.length <= editor.maxLength)
            )
        case "number": {
            if (
                typeof value !== "number" ||
                !Number.isFinite(value) ||
                (editor.min !== undefined && value < editor.min) ||
                (editor.max !== undefined && value > editor.max)
            )
                return false
            if (editor.step === undefined) return true
            const steps = (value - (editor.min ?? 0)) / editor.step
            return Math.abs(steps - Math.round(steps)) <= 1e-9
        }
    }
}

function acceptsDeclaredValue(validate: unknown, value: unknown): boolean {
    if (validate === undefined) return true
    if (typeof validate !== "function") return false
    try {
        return Boolean(validate(value))
    } catch {
        return false
    }
}
