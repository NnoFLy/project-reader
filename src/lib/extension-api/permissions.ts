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

export const SUPPORTED_EXTENSION_PERMISSIONS: readonly ExtensionPermission[] = [
    "storage",
    "notifications",
    "commands",
    "views",
    "documents",
    "settings",
]

const supportedPermissions = new Set<string>(SUPPORTED_EXTENSION_PERMISSIONS)

/**
 * Creates the immutable, host-validated permission view exposed to an extension.
 * This is an API capability gate, not a sandbox for hostile extension code.
 */
export function createPermissionSet(permissions: readonly ExtensionPermission[]): PermissionSet {
    const values = new Set<ExtensionPermission>()
    for (const permission of permissions) {
        if (!supportedPermissions.has(permission)) {
            throw new Error(`Unsupported permission: ${permission}`)
        }
        values.add(permission)
    }
    const listed = Object.freeze([...values]) as readonly ExtensionPermission[]
    return Object.freeze({
        has: (permission: ExtensionPermission) => values.has(permission),
        require: (permission: ExtensionPermission) => {
            if (!values.has(permission)) throw new PermissionDeniedError(permission)
        },
        list: () => listed,
    })
}

/** Guard a host capability while keeping the extension API framework-neutral. */
export function guardExtensionCapability<T extends object>(
    capability: T,
    permissions: PermissionSet,
    permission: ExtensionPermission,
): T {
    return new Proxy(capability, {
        get(target, property, receiver) {
            permissions.require(permission)
            const value = Reflect.get(target, property, receiver)
            return typeof value === "function" ? value.bind(target) : value
        },
    })
}
