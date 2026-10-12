import { createContext } from "svelte"
import type { StorageNamespace } from "$lib/extension-api"

export const LIBRARY_CARD_SIZE_LEVELS = [9, 11, 13, 15] as const
export const DEFAULT_LIBRARY_CARD_SIZE_LEVEL = 1
const LIBRARY_CARD_SIZE_STORAGE_KEY = "card-size-level"
let libraryStorage: StorageNamespace | undefined

export function configureLibraryUIStorage(storage: StorageNamespace): void {
    libraryStorage = storage
    void storage.get<string>(LIBRARY_CARD_SIZE_STORAGE_KEY).then((value) => {
        if (value !== undefined) libraryUIController?.setCardSizeLevel(Number(value))
    })
}

let libraryUIController: LibraryUIController | undefined

export function configureLibraryUIController(controller: LibraryUIController | undefined): void {
    libraryUIController = controller
}

export function parseLibraryCardSizeLevel(value: string | null): number {
    if (value === null || value.trim() === "") return DEFAULT_LIBRARY_CARD_SIZE_LEVEL
    const level = Number(value)
    return Number.isInteger(level) && level >= 0 && level < LIBRARY_CARD_SIZE_LEVELS.length
        ? level
        : DEFAULT_LIBRARY_CARD_SIZE_LEVEL
}

export class LibraryUIController {
    #cardSizeLevel = $state(DEFAULT_LIBRARY_CARD_SIZE_LEVEL)
    #isSelectionMode = $state(false)
    isPickingMode = $state(false)
    isNewFolderModalOpen = $state(false)
    isDeleteModalOpen = $state(false)
    nodesToDeleteIds = $state<string[]>([])
    nodeToMoveId = $state<string | null>(null)
    isEditMetadataModalOpen = $state(false)
    nodeToEditMetadataId = $state<string | null>(null)
    isRenameFolderModalOpen = $state(false)
    folderToRenameId = $state<string | null>(null)

    get cardSizeLevel(): number {
        return this.#cardSizeLevel
    }

    get cardSizeRem(): number {
        return LIBRARY_CARD_SIZE_LEVELS[this.#cardSizeLevel]
    }

    get canDecreaseCardSize(): boolean {
        return this.#cardSizeLevel > 0
    }

    get canIncreaseCardSize(): boolean {
        return this.#cardSizeLevel < LIBRARY_CARD_SIZE_LEVELS.length - 1
    }

    decreaseCardSize(): void {
        this.setCardSizeLevel(this.#cardSizeLevel - 1)
    }

    increaseCardSize(): void {
        this.setCardSizeLevel(this.#cardSizeLevel + 1)
    }

    setCardSizeLevel(level: number): void {
        const nextLevel = Math.max(0, Math.min(LIBRARY_CARD_SIZE_LEVELS.length - 1, level))
        if (nextLevel === this.#cardSizeLevel) return
        this.#cardSizeLevel = nextLevel
        void libraryStorage?.set(LIBRARY_CARD_SIZE_STORAGE_KEY, String(nextLevel))
    }

    get isSelectionMode(): boolean {
        return this.#isSelectionMode
    }

    set isSelectionMode(value: boolean) {
        this.#isSelectionMode = value
        if (!value) this.isPickingMode = false
    }

    clear(): void {
        this.isSelectionMode = false
        this.isPickingMode = false
        this.isNewFolderModalOpen = false
        this.isDeleteModalOpen = false
        this.nodesToDeleteIds = []
        this.nodeToMoveId = null
        this.isEditMetadataModalOpen = false
        this.nodeToEditMetadataId = null
        this.isRenameFolderModalOpen = false
        this.folderToRenameId = null
    }
}

const [getLibraryUIContext, setLibraryUIContext] = createContext<LibraryUIController>()

export function mountLibraryUI(): LibraryUIController {
    const controller = libraryUIController ?? new LibraryUIController()
    libraryUIController = controller
    setLibraryUIContext(controller)
    return controller
}

export function useLibraryUI(): LibraryUIController {
    return getLibraryUIContext()
}
