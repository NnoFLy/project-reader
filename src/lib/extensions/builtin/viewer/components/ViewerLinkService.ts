import type { ViewerPagedDocument } from "../viewerDocument"

/** Minimal link navigation bridge for viewer-owned document layer capabilities. */
export class ViewerLinkService {
    private _page = 1
    private _rotation = 0
    private _externalLinkEnabled = true

    constructor(
        private readonly document: ViewerPagedDocument,
        private readonly onNavigate: (pageNumber: number) => void,
    ) {}

    get pageCount(): number {
        return this.document.pageCount
    }

    get page(): number {
        return this._page
    }

    set page(value: number) {
        this._page = value
    }

    get rotation(): number {
        return this._rotation
    }

    set rotation(value: number) {
        this._rotation = value
    }

    get isInPresentationMode(): boolean {
        return false
    }

    get externalLinkEnabled(): boolean {
        return this._externalLinkEnabled
    }

    set externalLinkEnabled(value: boolean) {
        this._externalLinkEnabled = value
    }

    goToPage(value: number | string): void {
        const pageNumber = typeof value === "string" ? Number.parseInt(value, 10) : value
        if (Number.isInteger(pageNumber) && pageNumber >= 1 && pageNumber <= this.pageCount) {
            this.onNavigate(pageNumber)
        }
    }

    addLinkAttributes(link: HTMLAnchorElement, url: string): void {
        const isSafeProtocol = /^(https?:|mailto:|tel:)/i.test(url)
        link.href = isSafeProtocol ? url : "#"
        link.target = "_blank"
        link.rel = "noopener noreferrer"
    }

    getDestinationHash(): string {
        return "#"
    }

    getAnchorUrl(): string {
        return "#"
    }

    setHash(): void {}

    executeNamedAction(action: string): void {
        if (action === "NextPage") this.goToPage(this.page + 1)
        else if (action === "PrevPage") this.goToPage(this.page - 1)
    }

    executeSetOCGState(): void {}
}
