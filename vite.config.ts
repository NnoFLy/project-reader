import { paraglideVitePlugin } from "@inlang/paraglide-js"
import { sveltekit } from "@sveltejs/kit/vite"
import { configDefaults, defineConfig } from "vitest/config"
import basicSsl from "@vitejs/plugin-basic-ssl"

export default defineConfig({
    resolve: process.env.VITEST ? { conditions: ["browser"] } : undefined,
    server: {
        allowedHosts: true,
        watch: {
            ignored: ["**/.worktrees/**"],
        },
    },
    test: {
        exclude: [...configDefaults.exclude, "**/.worktrees/**"],
    },
    build: {
        chunkSizeWarningLimit: 600,
    },
    plugins: [
        sveltekit(),
        basicSsl(),
        paraglideVitePlugin({
            project: "./project.inlang",
            outdir: "./src/lib/paraglide",
            strategy: ["url", "cookie", "baseLocale"],
        }),
    ],
})
