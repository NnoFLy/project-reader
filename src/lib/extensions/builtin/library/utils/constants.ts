export const PICKER_KEYS = [
    "f",
    "s",
    "l",
    "a",
    ";",
    "g",
    "h",
    "'",
    "b",
    "n",
    "c",
    "m",
    "x",
    ",",
    "v",
    ".",
    "z",
    "/",
    "y",
    "r",
    "e",
    "t",
    "w",
    "i",
    "o",
    "p",
]

export function generateHints(count: number, keys: string[]): string[] {
    if (count <= keys.length) {
        return keys.slice(0, count)
    }

    const hints: string[] = []
    for (const first of keys) {
        for (const second of keys) {
            hints.push(first + second)
            if (hints.length === count) {
                return hints
            }
        }
    }
    return hints
}
