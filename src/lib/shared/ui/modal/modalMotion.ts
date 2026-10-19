export function shouldEnableModalPresentationMotion({
    appMotionEnabled,
    movementCritical,
}: {
    appMotionEnabled: boolean
    movementCritical: boolean
}): boolean {
    return appMotionEnabled || movementCritical
}
