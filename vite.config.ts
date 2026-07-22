import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [sveltekit()],
	ssr: {
		// Native modules must remain external in the standalone Node build.
		external: ['better-sqlite3']
	},
	server: {
		host: true, // bind to 0.0.0.0 so other devices on LAN can connect
		port: 5175,
		strictPort: true, // fail if port is already in use
		allowedHosts: ['mtg.home', 'mtg.home.mynetworksettings.com']
	}
});
