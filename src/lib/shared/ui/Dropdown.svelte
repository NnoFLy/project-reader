<script lang="ts">
    import { tick, type Snippet } from "svelte"

    interface Props {
        /** The trigger element/button. Spreads accessibility attributes and visual states. */
        trigger: Snippet<
            [
                {
                    id: string
                    onclick: (e: MouseEvent) => void
                    onkeydown: (e: KeyboardEvent) => void
                    "aria-haspopup": "menu"
                    "aria-expanded": boolean
                    "aria-controls": string
                    open: boolean
                },
            ]
        >
        /** The content of the dropdown menu (e.g. dropdown items). */
        children: Snippet
        /** Optional class names for the dropdown container. */
        class?: string
        /** Optional class names for the menu container. */
        menuClass?: string
        /** Alignment of the menu relative to the trigger. Defaults to 'right'. */
        align?: "left" | "right"
        /** Controlled open/close state of the dropdown. */
        isOpen?: boolean
    }

    let {
        trigger,
        children,
        class: className = "",
        menuClass = "",
        align = "right",
        isOpen = $bindable(false),
    }: Props = $props()

    let triggerContainer = $state<HTMLElement | null>(null)
    let menuElement = $state<HTMLElement | null>(null)

    const triggerId = `dropdown-trigger-${Math.random().toString(36).substring(2, 9)}`
    const menuId = `dropdown-menu-${Math.random().toString(36).substring(2, 9)}`

    let previouslyFocusedElement: HTMLElement | null = null

    function toggleMenu(e: MouseEvent) {
        e.stopPropagation()
        isOpen = !isOpen
    }

    function closeMenu() {
        isOpen = false
    }

    function handleTriggerClick(e: MouseEvent) {
        toggleMenu(e)
    }

    function handleTriggerKeyDown(_event: KeyboardEvent) {
        // Trigger keydowns are caught globally by layout, but kept for signature compatibility
    }

    function getMenuItems(): HTMLElement[] {
        if (!menuElement) return []
        return Array.from(
            menuElement.querySelectorAll(':scope > [role="menuitem"], :scope > button, :scope > a'),
        ) as HTMLElement[]
    }

    function focusItem(index: number) {
        const items = getMenuItems()
        if (items.length > 0 && index >= 0 && index < items.length) {
            items[index].focus()
        }
    }

    function handleWindowPointerDown(e: PointerEvent) {
        const target = e.target as HTMLElement
        const clickedInsideTrigger = triggerContainer?.contains(target)
        const clickedInsideMenu = menuElement?.contains(target)

        if (!clickedInsideTrigger && !clickedInsideMenu) {
            isOpen = false
        }
    }

    function handleWindowFocusIn(e: FocusEvent) {
        if (!isOpen) return
        const target = e.target as HTMLElement | null
        if (target && triggerContainer && !triggerContainer.contains(target)) {
            isOpen = false
        }
    }

    function handleMenuClick(e: MouseEvent) {
        const target = e.target as HTMLElement
        const clickedItem = target.closest('[role="menuitem"], button, a')
        if (clickedItem) {
            isOpen = false
        }
    }

    function handleDropdownKeydown(event: KeyboardEvent) {
        if (!isOpen || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return
        const items = getMenuItems()
        const activeElement = document.activeElement as HTMLElement
        const currentIndex = items.indexOf(activeElement)
        let handled = true

        switch (event.key.toLowerCase()) {
            case "arrowdown":
            case "j":
                focusItem((currentIndex + 1) % items.length)
                break
            case "arrowup":
            case "k":
                focusItem((currentIndex - 1 + items.length) % items.length)
                break
            case "home":
                focusItem(0)
                break
            case "end":
                focusItem(items.length - 1)
                break
            case "escape":
                closeMenu()
                break
            case "enter":
            case " ":
                if (items.includes(activeElement)) activeElement.click()
                else handled = false
                break
            default:
                handled = false
        }

        if (handled) {
            event.preventDefault()
            event.stopPropagation()
        }
    }

    $effect(() => {
        if (isOpen) {
            previouslyFocusedElement = document.activeElement as HTMLElement
            void tick().then(() => focusItem(0))
        } else if (!isOpen && previouslyFocusedElement) {
            // Restore focus back to the launcher element when closing, unless focus has already moved elsewhere
            const activeEl = document.activeElement
            const isFocusStillInside = activeEl && triggerContainer?.contains(activeEl)
            const isFocusLost = !activeEl || activeEl === document.body

            if (isFocusStillInside || isFocusLost) {
                previouslyFocusedElement.focus()
            }
            previouslyFocusedElement = null
        }
    })
</script>

<svelte:window onpointerdown={handleWindowPointerDown} onfocusin={handleWindowFocusIn} />

<div
    bind:this={triggerContainer}
    class={["dropdown-container", className].filter(Boolean).join(" ")}
>
    {@render trigger({
        id: triggerId,
        onclick: handleTriggerClick,
        onkeydown: handleTriggerKeyDown,
        "aria-haspopup": "menu",
        "aria-expanded": isOpen,
        "aria-controls": menuId,
        open: isOpen,
    })}

    {#if isOpen}
        <div
            id={menuId}
            bind:this={menuElement}
            role="menu"
            aria-labelledby={triggerId}
            class={["dropdown-menu", align === "left" ? "align-left" : "align-right", menuClass]
                .filter(Boolean)
                .join(" ")}
            tabindex="-1"
            onclick={handleMenuClick}
            onkeydown={handleDropdownKeydown}
        >
            {@render children()}
        </div>
    {/if}
</div>

<style>
    .dropdown-container {
        position: relative;
        display: inline-block;
    }

    .dropdown-menu {
        position: absolute;
        top: calc(100% + 6px);
        background: var(--surface-color);
        border: var(--border-inline) solid var(--border-color);
        box-shadow: var(--shadow-elevated);
        min-width: 160px;
        z-index: var(--z-sticky);
        overflow: hidden;
        display: flex;
        flex-direction: column;
    }

    .dropdown-menu.align-right {
        right: 0;
    }

    .dropdown-menu.align-left {
        left: 0;
    }

    /* Styles for nested items to look uniform */
    .dropdown-menu :global(.dropdown-item) {
        width: 100%;
        padding: 10px 12px;
        display: grid;
        grid-template-columns: 24px 1fr;
        align-items: center;
        justify-content: flex-start;
        gap: 12px;
        background: transparent;
        border: none;
        color: var(--text-color);
        font-family: inherit;
        font-size: var(--font-size-base);
        font-weight: 600;
        cursor: pointer;
        text-align: left;
        transition:
            background-color 0.1s ease,
            box-shadow 0.1s ease;
        box-sizing: border-box;
    }

    @media (hover: hover) {
        .dropdown-menu :global(.dropdown-item):hover,
        .dropdown-menu :global(.dropdown-item):focus-visible {
            background-color: var(--surface-hover-color);
            color: var(--text-color);
            box-shadow: inset 3px 0 0 var(--active-color);
            outline: none;
        }
    }

    .dropdown-menu :global(.dropdown-item):active {
        background-color: var(--surface-hover-color);
    }

    .dropdown-menu :global(.dropdown-icon) {
        width: 16px;
        height: 16px;
    }

    @media (--mobile-width) {
        .dropdown-menu {
            min-width: 140px;
            box-shadow: 2px 2px 0 var(--shadow-color);
        }

        .dropdown-menu :global(.dropdown-item) {
            padding: 8px 10px;
            font-size: var(--font-size-sm);
        }
    }
</style>
