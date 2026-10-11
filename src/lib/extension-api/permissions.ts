import type { ExtensionPermission } from "./contracts"

export interface PermissionSet {
    has(permission: ExtensionPermission): boolean
    require(permission: ExtensionPermission): void
    list(): readonly ExtensionPermission[]
}

export class PermissionDeniedError extends Error {
    readonly code = "permission.denied"

    constructor(readonly permission: ExtensionPermission) {
        super(`Extension does not have permission: ${permission}`)
        this.name = "PermissionDeniedError"
    }
}

export function createPermissionSet(permissions: readonly ExtensionPermission[]): PermissionSet {
    const values = new Set(permissions)
    return {
        has: (permission) => values.has(permission),
        require: (permission) => {
            if (!values.has(permission)) throw new PermissionDeniedError(permission)
        },
        list: () => [...values],
    }
}
