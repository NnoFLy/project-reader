<script lang="ts">
    import { LibraryPage } from "$lib/modules/library"
    import * as m from "$lib/paraglide/messages"
</script>

<svelte:head>
    <title>{m.library_page_title()}</title>
</svelte:head>

<LibraryPage />
