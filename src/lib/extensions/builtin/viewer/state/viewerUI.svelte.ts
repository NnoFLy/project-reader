import { createContext } from "svelte"

export class ViewerUIController {
    isToolbarsVisible = $state(true)

    toggleToolbars(): void {
        this.isToolbarsVisible = !this.isToolbarsVisible
    }
}

const [getViewerUIContext, setViewerUIContext] = createContext<ViewerUIController>()

export function mountViewerUI(): ViewerUIController {
    const controller = new ViewerUIController()
    setViewerUIContext(controller)
    return controller
}

export function useViewerUI(): ViewerUIController {
    return getViewerUIContext()
}
