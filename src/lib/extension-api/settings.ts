import type { Disposable, SettingContribution } from "./contracts"

export interface RegisteredSetting<T = unknown> extends SettingContribution<T> {
    readonly extensionId: string
}

export interface SettingsRegistry {
    register<T>(setting: SettingContribution<T>): Disposable
    get<T = unknown>(settingId: string): RegisteredSetting<T> | undefined
    list(): readonly RegisteredSetting[]
    getValue<T>(settingId: string): Promise<T>
    setValue<T>(settingId: string, value: T): Promise<void>
}
