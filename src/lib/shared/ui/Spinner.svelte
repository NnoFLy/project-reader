<script lang="ts">
    interface Props {
        variant?: "classic" | "square" | "dots"
        size?: "sm" | "md" | "lg" | "xl"
        stepped?: boolean
        speed?: "slow" | "normal" | "fast"
        label?: string
        labelPosition?: "bottom" | "right"
        class?: string
        style?: string
    }

    let {
        variant = "classic",
        size = "md",
        stepped = true,
        speed = "normal",
        label,
        labelPosition = "bottom",
        class: className = "",
        ...props
    }: Props = $props()
</script>

<div class="spinner-container {labelPosition} {className}" {...props}>
    {#if variant === "classic"}
        <div class="spinner-element classic size-{size} speed-{speed}" class:stepped></div>
    {:else if variant === "square"}
        <div class="spinner-element square size-{size} speed-{speed}" class:stepped>
            <div class="square-outer">
                <div class="square-inner"></div>
            </div>
        </div>
    {:else if variant === "dots"}
        <div class="spinner-element dots size-{size} speed-{speed}">
            <span class="dot dot-1"></span>
            <span class="dot dot-2"></span>
            <span class="dot dot-3"></span>
        </div>
    {/if}

    {#if label}
        <span class="spinner-label size-{size}">{label}</span>
    {/if}
</div>

<style>
    .spinner-container {
        display: inline-flex;
        align-items: center;
        box-sizing: border-box;
        vertical-align: middle;
    }

    .spinner-container.bottom {
        flex-direction: column;
        justify-content: center;
        gap: 12px;
    }

    .spinner-container.right {
        flex-direction: row;
        justify-content: flex-start;
        gap: 12px;
    }

    .size-sm {
        --spinner-size: 20px;
        --thickness: 2px;
        --dot-size: 6px;
        --dot-gap: 3px;
        --font-size: var(--font-size-sm);
    }

    .size-md {
        --spinner-size: 36px;
        --thickness: 3px;
        --dot-size: 10px;
        --dot-gap: 5px;
        --font-size: var(--font-size-base);
    }

    .size-lg {
        --spinner-size: 56px;
        --thickness: 4px;
        --dot-size: 14px;
        --dot-gap: 7px;
        --font-size: var(--font-size-lg);
    }

    .size-xl {
        --spinner-size: 80px;
        --thickness: 5px;
        --dot-size: 20px;
        --dot-gap: 9px;
        --font-size: var(--font-size-xl);
    }

    .spinner-element {
        --speed-slow: 1.5s;
        --speed-normal: 0.8s;
        --speed-fast: 0.4s;
    }

    .spinner-element.speed-slow {
        --spinner-duration: var(--speed-slow);
    }

    .spinner-element.speed-normal {
        --spinner-duration: var(--speed-normal);
    }

    .spinner-element.speed-fast {
        --spinner-duration: var(--speed-fast);
    }

    .spinner-element.stepped {
        --spinner-timing: steps(8);
    }

    /* One cycle introduces each variant, then leaves a stable loading indicator. */
    .spinner-element.classic {
        inline-size: var(--spinner-size);
        block-size: var(--spinner-size);
        border: var(--thickness) solid var(--border-color);
        border-radius: var(--radius-full);
        border-top-color: var(--danger-active-color);
        border-right-color: var(--danger-active-color);
        box-sizing: border-box;
        flex-shrink: 0;
        animation: spin var(--spinner-duration) var(--spinner-timing, linear);
        transition: border-color 0.3s ease;
    }

    .spinner-element.square {
        inline-size: var(--spinner-size);
        block-size: var(--spinner-size);
        position: relative;
        box-sizing: border-box;
        flex-shrink: 0;
        display: flex;
        align-items: center;
        justify-content: center;
    }

    .square-outer {
        animation: spin var(--spinner-duration) var(--spinner-timing, linear);
        inline-size: 100%;
        block-size: 100%;
        border: var(--thickness) solid var(--border-color);
        background-color: var(--surface-color);
        box-shadow: 2px 2px 0 var(--shadow-color);
        box-sizing: border-box;
        position: relative;
        display: flex;
        align-items: center;
        justify-content: center;
        transition:
            background-color 0.3s ease,
            border-color 0.3s ease,
            box-shadow 0.3s ease;
    }

    .square-inner {
        animation: spin-counter-clockwise var(--spinner-duration) var(--spinner-timing, linear);
        inline-size: 42%;
        block-size: 42%;
        background-color: var(--danger-active-color);
        border: calc(var(--thickness) * 0.7) solid var(--border-color);
        box-sizing: border-box;
        transition: border-color 0.3s ease;
    }

    .spinner-element.dots {
        display: inline-flex;
        gap: var(--dot-gap);
        align-items: center;
        justify-content: center;
        block-size: var(--spinner-size);
        flex-shrink: 0;
    }

    .dot {
        animation: dot-pulse var(--spinner-duration);
        inline-size: var(--dot-size);
        block-size: var(--dot-size);
        background-color: var(--text-color);
        border: calc(var(--thickness) * 0.5) solid var(--border-color);
        box-shadow: 1px 1px 0 var(--shadow-color);
        display: inline-block;
        box-sizing: border-box;
        transition:
            background-color 0.3s ease,
            border-color 0.3s ease,
            box-shadow 0.3s ease;
    }

    .dot-2 {
        animation-delay: calc(var(--spinner-duration) / 4);
    }

    .dot-3 {
        animation-delay: calc(var(--spinner-duration) / 2);
    }

    .spinner-label {
        font-family: inherit;
        font-size: var(--font-size);
        font-weight: bold;
        text-transform: uppercase;
        color: var(--text-color);
        letter-spacing: 0.5px;
        margin: 0;
        text-align: center;
        transition: color 0.3s ease;
    }

    @keyframes spin {
        from {
            transform: rotate(0deg);
        }
        to {
            transform: rotate(360deg);
        }
    }

    @keyframes spin-counter-clockwise {
        from {
            transform: rotate(0deg);
        }
        to {
            transform: rotate(-360deg);
        }
    }

    @keyframes dot-pulse {
        0%,
        100% {
            transform: translateY(0);
            background-color: var(--text-color);
        }
        50% {
            transform: translateY(-30%);
            background-color: var(--danger-active-color);
            box-shadow: 2px 2px 0 var(--shadow-color);
        }
    }
</style>
