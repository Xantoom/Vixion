import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

// The server (cargo run) answers the API and the media; the dev server only serves the interface.
const backend = process.env.VIXION_BACKEND ?? 'http://127.0.0.1:8080';

export default defineConfig({
	define: { __VIXION_VERSION__: JSON.stringify(version) },
	plugins: [react(), tailwindcss()],
	resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
	server: {
		proxy: {
			'/api': { target: backend, changeOrigin: false },
			'/media': { target: backend, changeOrigin: false },
		},
	},
	build: {
		target: 'es2023',
		sourcemap: false,
		reportCompressedSize: false,
		chunkSizeWarningLimit: 900,
		rollupOptions: {
			output: {
				// Long-lived chunks: the libraries change less often than the app.
				manualChunks(id) {
					if (id.includes('node_modules/mediabunny')) return 'mediabunny';
					if (id.includes('node_modules/react') || id.includes('node_modules/scheduler')) return 'react';
					if (id.includes('node_modules/@tanstack')) return 'tanstack';
					return undefined;
				},
			},
		},
	},
});
