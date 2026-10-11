<script lang="ts">
    import { LibraryRoute } from "$lib/app"
    import * as m from "$lib/paraglide/messages"
</script>

<svelte:head>
    <title>{m.library_page_title()}</title>
</svelte:head>

<LibraryRoute />
