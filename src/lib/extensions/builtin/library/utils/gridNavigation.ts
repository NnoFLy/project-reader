export function getGridColumns(cards: HTMLElement[]): number {
    if (cards.length <= 1) return 1
    const firstTop = cards[0].getBoundingClientRect().top
    for (let i = 1; i < cards.length; i++) {
        // Use a tolerance of 20px because focused cards shift by 4px via CSS transform (translate(-4px, -4px)).
        if (Math.abs(cards[i].getBoundingClientRect().top - firstTop) > 20) {
            return i
        }
    }
    return cards.length
}

export function navigateGrid(
    direction: "up" | "down" | "left" | "right",
    lastFocusedCardId: string | null,
    animations: boolean,
    repeated = false,
) {
    const cards = Array.from(
        document.querySelectorAll(".card_list.grid .card:not(:disabled)"),
    ) as HTMLElement[]
    if (cards.length === 0) return

    const activeEl = document.activeElement as HTMLElement | null
    let currentIndex = -1
    if (activeEl) {
        currentIndex = cards.indexOf(activeEl)
        if (currentIndex === -1) {
            const cardAncestor = activeEl.closest(".card") as HTMLElement | null
            if (cardAncestor) {
                currentIndex = cards.indexOf(cardAncestor)
            }
        }
    }

    // Helper to check if a card is currently visible in the viewport
    const isCardVisible = (card: HTMLElement) => {
        const rect = card.getBoundingClientRect()
        return rect.bottom > 0 && rect.top < window.innerHeight
    }

    // If the focused card is scrolled out of view, treat it as if we have no focus.
    if (currentIndex !== -1 && !isCardVisible(cards[currentIndex])) {
        currentIndex = -1
    }

    // If no active element is a visible card, try the lastFocusedCardId ONLY if it is still visible.
    if (currentIndex === -1 && lastFocusedCardId) {
        const lastFocusedEl = cards.find((c) => c.getAttribute("data-id") === lastFocusedCardId)
        if (lastFocusedEl && isCardVisible(lastFocusedEl)) {
            currentIndex = cards.indexOf(lastFocusedEl)
        }
    }

    let nextIndex = currentIndex

    if (currentIndex === -1) {
        // Find all cards currently visible in the viewport
        const visibleIndices = cards
            .map((card, index) => ({ card, index }))
            .filter(({ card }) => isCardVisible(card))
            .map(({ index }) => index)

        if (visibleIndices.length > 0) {
            if (direction === "left" || direction === "up") {
                // Focus the last visible card on screen when going backward
                nextIndex = visibleIndices[visibleIndices.length - 1]
            } else {
                // Focus the first visible card on screen when going forward
                nextIndex = visibleIndices[0]
            }
        } else {
            // Fallback to absolute boundaries if absolutely nothing is visible
            if (direction === "left" || direction === "up") {
                nextIndex = cards.length - 1
            } else {
                nextIndex = 0
            }
        }
    } else {
        const cols = getGridColumns(cards)
        if (direction === "left") {
            nextIndex = currentIndex - 1
            if (nextIndex < 0) {
                nextIndex = 0
            }
        } else if (direction === "right") {
            nextIndex = currentIndex + 1
            if (nextIndex >= cards.length) {
                nextIndex = cards.length - 1
            }
        } else if (direction === "up") {
            nextIndex = currentIndex - cols
            if (nextIndex < 0) {
                nextIndex = currentIndex
            }
        } else if (direction === "down") {
            nextIndex = currentIndex + cols
            if (nextIndex >= cards.length) {
                const totalRows = Math.ceil(cards.length / cols)
                const currentRow = Math.floor(currentIndex / cols)
                if (currentRow < totalRows - 1) {
                    nextIndex = cards.length - 1
                } else {
                    nextIndex = currentIndex
                }
            }
        }
    }

    if (cards[nextIndex]) {
        cards[nextIndex].focus({ preventScroll: true })
        const behavior = !repeated && animations ? "smooth" : "auto"
        cards[nextIndex].scrollIntoView({ block: "nearest", behavior })
    }
}
