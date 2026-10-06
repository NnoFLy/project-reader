import { browser } from "$app/environment"

export function getSafeStorage(): Storage | null {
    if (!browser) return null
    try {
        return localStorage
    } catch {
        return null
    }
}

export function safeStorageGet(key: string): string | null {
    try {
        return getSafeStorage()?.getItem(key) ?? null
    } catch {
        return null
    }
}

export function safeStorageSet(key: string, value: string): boolean {
    try {
        getSafeStorage()?.setItem(key, value)
        return true
    } catch {
        return false
    }
}

export function safeStorageRemove(key: string): boolean {
    try {
        getSafeStorage()?.removeItem(key)
        return true
    } catch {
        return false
    }
}
