import {
    assertNamespacedId,
    belongsToExtension,
    type Disposable,
    type RegisteredSetting,
    type SettingContribution,
    type SettingsRegistry,
} from "../../extension-api"

export interface SettingsStore {
    get<T>(id: string): Promise<T | undefined>
    set<T>(id: string, value: T): Promise<void>
}

export class SettingsRegistryImpl implements SettingsRegistry {
    private readonly settings = new Map<string, RegisteredSetting>()
    private readonly values = new Map<string, unknown>()
    private disposed = false

    constructor(
        private readonly extensionId: string,
        private readonly store?: SettingsStore,
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
        this.settings.set(setting.id, { ...setting, extensionId: this.extensionId })
        let active = true
        return {
            dispose: () => {
                if (!active) return
                active = false
                this.settings.delete(setting.id)
                this.values.delete(setting.id)
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
        const setting = this.settings.get(settingId) as RegisteredSetting<T> | undefined
        if (!setting) throw new Error(`Setting is not registered: ${settingId}`)
        const stored = this.store ? await this.store.get<T>(settingId) : this.values.get(settingId)
        return (stored === undefined ? setting.defaultValue : stored) as T
    }

    async setValue<T>(settingId: string, value: T): Promise<void> {
        const setting = this.settings.get(settingId) as RegisteredSetting<T> | undefined
        if (!setting) throw new Error(`Setting is not registered: ${settingId}`)
        if (setting.validate && !setting.validate(value))
            throw new Error(`Invalid value for setting: ${settingId}`)
        if (this.store) await this.store.set(settingId, value)
        else this.values.set(settingId, value)
    }

    dispose(): void {
        this.disposed = true
        this.settings.clear()
        this.values.clear()
    }

    private assertUsable(): void {
        if (this.disposed) throw new Error(`Settings registry for ${this.extensionId} is disposed`)
    }
}
