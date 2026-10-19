<script lang="ts">
    import type { Attachment } from "svelte/attachments"
    import type { HTMLInputAttributes } from "svelte/elements"

    interface Props extends HTMLInputAttributes {
        label?: string
        value?: string | number
        errors?: string[]
        classInput?: string
        ref?: HTMLInputElement | null
        attachment?: Attachment<HTMLInputElement>
        unstyled?: boolean
    }

    let {
        label,
        value = $bindable(""),
        errors = [],
        class: className = "",
        classInput,
        ref = $bindable(null),
        attachment,
        unstyled = false,
        ...props
    }: Props = $props()

    function captureInput(node: HTMLInputElement) {
        ref = node
        return () => {
            if (ref === node) ref = null
        }
    }
</script>

<div class={`input-group ${!unstyled ? className : ""} ${unstyled ? "unstyled" : ""}`}>
    {#if label}
        <label class="input-label" for={props.id}>{label}</label>
    {/if}
    <input
        {@attach captureInput}
        {@attach attachment}
        class={!unstyled ? `input-field ${classInput ?? ""}` : className}
        class:has-error={!unstyled && errors.length > 0}
        bind:value
        {...props}
    />
    {#if errors.length > 0}
        {#each errors as error (error)}
            <span class="error-text">{error}</span>
        {/each}
    {/if}
</div>

<style>
    .input-group {
        display: flex;
        flex-direction: column;
        gap: 8px;
        width: 100%;
    }

    .input-group.unstyled {
        display: contents;
    }

    input {
        font-size: var(--font-size-input);
    }

    .input-label {
        color: var(--text-color);
        font-family: var(--ui-font);
        font-size: var(--font-size-base);
        font-weight: 700;
    }

    .input-field {
        min-height: var(--control-height-regular);
        box-sizing: border-box;
        padding: 8px var(--control-padding-inline);
        border: 1px solid var(--color-control-border);
        border-radius: var(--radius-sm);
        background: var(--surface-color);
        box-shadow: var(--shadow-inline);
        color: var(--text-color);
        font-family: var(--ui-font);
        outline: none;
        transition:
            border-color 0.12s ease,
            box-shadow 0.12s ease,
            background-color 0.12s ease;
    }

    .input-field:focus-visible {
        border-color: var(--accent-color);
        box-shadow: var(--focus-ring);
    }

    .input-field::placeholder {
        color: var(--faded-text-color);
        opacity: 1;
    }

    .input-field.has-error {
        border-color: var(--danger-color);
    }

    .error-text {
        font-size: var(--font-size-sm);
        font-weight: 700;
        color: var(--danger-color);
    }
</style>
