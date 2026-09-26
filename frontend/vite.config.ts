import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const apiTarget = process.env.FOLIO_API_TARGET ?? "http://127.0.0.1:8000";

export default defineConfig({
	plugins: [react(), tailwindcss()],
	server: {
		host: "127.0.0.1",
		port: 5173,
		strictPort: true,
		proxy: { "/api": apiTarget },
	},
	preview: {
		host: "127.0.0.1",
		port: 4173,
		strictPort: true,
		proxy: { "/api": apiTarget },
	},
});
