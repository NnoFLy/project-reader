/* Keyboard normalization and display utilities shared by command adapters. */
const CODE_TO_KEY: Record<string, string> = {
    Digit1: "1",
    Digit2: "2",
    Digit3: "3",
    Digit4: "4",
    Digit5: "5",
    Digit6: "6",
    Digit7: "7",
    Digit8: "8",
    Digit9: "9",
    Digit0: "0",
    KeyA: "a",
    KeyB: "b",
    KeyC: "c",
    KeyD: "d",
    KeyE: "e",
    KeyF: "f",
    KeyG: "g",
    KeyH: "h",
    KeyI: "i",
    KeyJ: "j",
    KeyK: "k",
    KeyL: "l",
    KeyM: "m",
    KeyN: "n",
    KeyO: "o",
    KeyP: "p",
    KeyQ: "q",
    KeyR: "r",
    KeyS: "s",
    KeyT: "t",
    KeyU: "u",
    KeyV: "v",
    KeyW: "w",
    KeyX: "x",
    KeyY: "y",
    KeyZ: "z",
    Minus: "-",
    Equal: "=",
    BracketLeft: "[",
    BracketRight: "]",
    Semicolon: ";",
    Quote: "'",
    Backquote: "`",
    Comma: ",",
    Period: ".",
    Slash: "/",
    Backslash: "\\",
    Enter: "enter",
    Escape: "escape",
    Space: "space",
    ArrowUp: "arrowup",
    ArrowDown: "arrowdown",
    ArrowLeft: "arrowleft",
    ArrowRight: "arrowright",
    PageUp: "pageup",
    PageDown: "pagedown",
}

export class KeyboardHandler {
    static isMac(): boolean {
        if (typeof window === "undefined") return false
        const platform = (navigator as any).userAgentData?.platform || navigator.platform || ""
        return /Mac|iPod|iPhone|iPad/i.test(platform) || /Macintosh/i.test(navigator.userAgent)
    }

    static isChromiumNonMac(): boolean {
        if (typeof window === "undefined") return false
        const ua = navigator.userAgent
        const isMac = KeyboardHandler.isMac()
        const isChromium = /Chrome|Chromium|CriOS/i.test(ua) && !/Firefox/i.test(ua)
        return isChromium && !isMac
    }

    static normalize(keys: string): string {
        let trimmedKeys = keys.trim()
        if (trimmedKeys === "") {
            if (keys === " ") return "space"
            return ""
        }

        let parts: string[]
        const lowerKeys = trimmedKeys.toLowerCase()
        if (lowerKeys === "+") {
            parts = ["+"]
        } else if (lowerKeys.endsWith("+")) {
            let base = lowerKeys.slice(0, -1).trim()
            if (base.endsWith("+")) {
                base = base.slice(0, -1).trim()
            }
            parts = [...base.split("+"), "+"]
        } else {
            parts = lowerKeys.split("+")
        }

        const isMacPlatform = KeyboardHandler.isMac()
        return parts
            .map((k) => {
                const trimmed = k.trim()
                if (trimmed === "mod") {
                    return isMacPlatform ? "meta" : "ctrl"
                }
                if (trimmed === "space" || trimmed === "spacebar") {
                    return "space"
                }
                return trimmed
            })
            .filter(Boolean)
            .sort()
            .join("+")
    }

    static fromEvent(event: KeyboardEvent, useCode: boolean): string {
        const parts: string[] = []
        if (event.ctrlKey) parts.push("ctrl")
        if (event.metaKey) parts.push("meta")
        if (event.altKey) parts.push("alt")
        if (event.shiftKey) parts.push("shift")

        let key: string
        if (useCode) {
            key = CODE_TO_KEY[event.code] || event.key.toLowerCase()
        } else {
            key = event.key === " " || event.key === "Spacebar" ? "space" : event.key.toLowerCase()
        }

        parts.push(key)
        return parts.sort().join("+")
    }

    static candidates(event: KeyboardEvent): ReadonlySet<string> {
        const candidates = new Set([
            KeyboardHandler.fromEvent(event, true),
            KeyboardHandler.fromEvent(event, false),
        ])

        if (!event.ctrlKey && !event.metaKey && !event.altKey) {
            const isShiftLetter =
                event.shiftKey && event.key.toLowerCase() !== event.key.toUpperCase()
            const keyLower = event.key.toLowerCase()
            const singleKey = keyLower === " " || keyLower === "spacebar" ? "space" : keyLower
            const isShiftNamedKey = event.shiftKey && singleKey.length > 1
            if (!isShiftLetter && !isShiftNamedKey) candidates.add(singleKey)
        }

        return candidates
    }

    static matchesCandidates(
        candidates: ReadonlySet<string>,
        keys: string | readonly string[],
    ): boolean {
        return (Array.isArray(keys) ? keys : [keys]).some((key) => candidates.has(key))
    }

    static matches(event: KeyboardEvent, keys: string | string[]): boolean {
        const normalized = (Array.isArray(keys) ? keys : [keys]).map(KeyboardHandler.normalize)
        return KeyboardHandler.matchesCandidates(KeyboardHandler.candidates(event), normalized)
    }

    static resolveDirection(
        event: KeyboardEvent,
        upKeys: string | string[],
        downKeys: string | string[],
    ): "up" | "down" | undefined {
        if (KeyboardHandler.matches(event, upKeys)) return "up"
        if (KeyboardHandler.matches(event, downKeys)) return "down"
        return undefined
    }

    static getFormattedParts(keys: string): string[] {
        const isMacPlatform = KeyboardHandler.isMac()
        const MODIFIERS = ["ctrl", "meta", "mod", "alt", "shift"]

        let parts: string[]
        const trimmed = keys.trim()
        if (trimmed === "+") {
            parts = ["+"]
        } else if (trimmed.startsWith("++")) {
            parts = [
                "+",
                ...trimmed
                    .slice(2)
                    .split("+")
                    .map((p) => p.trim()),
            ]
        } else if (trimmed.endsWith("++")) {
            parts = [
                ...trimmed
                    .slice(0, -2)
                    .split("+")
                    .map((p) => p.trim()),
                "+",
            ]
        } else {
            parts = trimmed.split("+").map((p) => p.trim())
        }

        parts.sort((a, b) => {
            const aLower = a.toLowerCase()
            const bLower = b.toLowerCase()
            const aIdx = MODIFIERS.indexOf(aLower)
            const bIdx = MODIFIERS.indexOf(bLower)

            if (aIdx !== -1 && bIdx !== -1) {
                return aIdx - bIdx
            }
            if (aIdx !== -1) {
                return -1
            }
            if (bIdx !== -1) {
                return 1
            }
            return aLower.localeCompare(bLower)
        })

        return parts
            .map((part) => {
                const lower = part.toLowerCase()
                if (lower === "arrowleft") return "←"
                if (lower === "arrowright") return "→"
                if (lower === "arrowup") return "↑"
                if (lower === "arrowdown") return "↓"
                if (lower === "ctrl") return "Ctrl"
                if (lower === "meta") return isMacPlatform ? "⌘" : "Win"
                if (lower === "mod") return isMacPlatform ? "⌘" : "Ctrl"
                if (lower === "shift") return "Shift"
                if (lower === "alt") return isMacPlatform ? "⌥" : "Alt"
                if (lower === "space") return "Space"
                if (lower === "escape") return "Esc"
                return part.toUpperCase()
            })
            .filter(Boolean)
    }

    static format(keys: string | string[]): string {
        if (Array.isArray(keys)) {
            return keys.map((k) => KeyboardHandler.format(k)).join("/")
        }
        return KeyboardHandler.getFormattedParts(keys).join("+")
    }
}
