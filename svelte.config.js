import adapter from '@sveltejs/adapter-node';
import { networkInterfaces } from 'node:os';

const port = process.env.PORT ?? '5173';
const trustedOrigins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);
for (const entries of Object.values(networkInterfaces())) {
	for (const entry of entries ?? []) {
		if (entry.family === 'IPv4' && !entry.internal && isPrivateAddress(entry.address)) {
			trustedOrigins.add(`http://${entry.address}:${port}`);
		}
	}
}

function isPrivateAddress(address) {
	const parts = address.split('.').map(Number);
	return (
		parts.length === 4 &&
		(parts[0] === 10 ||
			(parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
			(parts[0] === 192 && parts[1] === 168))
	);
}

/** @type {import('@sveltejs/kit').Config} */
const config = {
	compilerOptions: {
		// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
		runes: ({ filename }) => (filename.split(/[/\\]/).includes('node_modules') ? undefined : true)
	},
	kit: {
		adapter: adapter({ out: 'build' }),
		csrf: {
			trustedOrigins: [...trustedOrigins]
		},

		typescript: {
			config: (config) => ({
				...config,
				include: [...config.include, '../drizzle.config.ts']
			})
		}
	}
};

export default config;
