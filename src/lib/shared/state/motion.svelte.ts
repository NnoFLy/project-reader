import { browser } from "$app/environment"

// The system preference supplies the default, not an override of the app setting.
export const DEFAULT_ANIMATIONS =
    !browser || !window.matchMedia("(prefers-reduced-motion: reduce)").matches

class MotionPreferences {
    enabled = $state(DEFAULT_ANIMATIONS)
}

export const motionPreferences = new MotionPreferences()
