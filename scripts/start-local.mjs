import { spawn } from 'node:child_process';
import { createSocket } from 'node:dgram';
import { existsSync, readFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const entry = path.join(root, 'build', 'index.js');
if (!existsSync(entry)) {
	console.error('Production build not found. Run pnpm build first.');
	process.exit(1);
}

const localEnv = path.join(root, '.env');
if (existsSync(localEnv)) {
	for (const rawLine of readFileSync(localEnv, 'utf8').split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line || line.startsWith('#')) continue;
		const separator = line.indexOf('=');
		if (separator < 1) continue;
		const key = line.slice(0, separator).trim();
		const value = line
			.slice(separator + 1)
			.trim()
			.replace(/^(['"])(.*)\1$/, '$2');
		if (!(key in process.env)) process.env[key] = value;
	}
}

const requestedPort = Number.parseInt(process.env.PORT ?? '5173', 10);
if (!Number.isInteger(requestedPort) || requestedPort < 1 || requestedPort > 65535) {
	console.error('PORT must be a number between 1 and 65535.');
	process.exit(1);
}

const host = process.env.HOST ?? '127.0.0.1';
const url = `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${requestedPort}`;
const lanEnabled = process.env.LAN_ACCESS === '1' || host === '0.0.0.0';

async function getLanUrls() {
	if (!lanEnabled) return [];
	const preferredAddress = await getPreferredLanAddress();
	if (preferredAddress && isPrivateAddress(preferredAddress)) {
		return [`http://${preferredAddress}:${requestedPort}`];
	}

	const addresses = new Set();
	for (const [name, entries] of Object.entries(networkInterfaces())) {
		if (/vmware|virtualbox|default switch|wsl|docker|tailscale|loopback/i.test(name)) {
			continue;
		}
		for (const entry of entries ?? []) {
			if (entry.family === 'IPv4' && !entry.internal && isPrivateAddress(entry.address)) {
				addresses.add(`http://${entry.address}:${requestedPort}`);
			}
		}
	}
	return [...addresses];
}

function getPreferredLanAddress() {
	return new Promise((resolve) => {
		const socket = createSocket('udp4');
		let settled = false;
		const timeout = setTimeout(() => finish(null), 500);
		const finish = (address) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			socket.close();
			resolve(address);
		};
		socket.once('error', () => finish(null));
		socket.connect(53, '1.1.1.1', () => {
			const address = socket.address();
			finish(typeof address === 'object' ? address.address : null);
		});
	});
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

const lanUrls = await getLanUrls();
const child = spawn(process.execPath, [entry], {
	cwd: root,
	env: {
		...process.env,
		HOST: host,
		PORT: String(requestedPort),
		ORIGIN: process.env.ORIGIN ?? url,
		BODY_SIZE_LIMIT: process.env.BODY_SIZE_LIMIT ?? '25M'
	},
	stdio: 'inherit'
});

let stopping = false;
function stop(signal) {
	if (stopping) return;
	stopping = true;
	child.kill(signal);
}
process.on('SIGINT', () => stop('SIGINT'));
process.on('SIGTERM', () => stop('SIGTERM'));
child.on('exit', (code, signal) => {
	process.exitCode = stopping ? 0 : signal ? 1 : (code ?? 1);
});

async function waitUntilReady() {
	for (let attempt = 0; attempt < 80; attempt++) {
		if (child.exitCode !== null) throw new Error('Local server exited before it became ready.');
		try {
			const response = await fetch(`${url}/api/health`);
			if (response.ok) return;
		} catch {
			// The server is still starting.
		}
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
	throw new Error(`Local server did not become ready at ${url}.`);
}

function openBrowser() {
	if (process.env.NO_OPEN === '1') return;
	const command =
		process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
	const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
	const opener = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
	opener.unref();
}

try {
	await waitUntilReady();
	console.log('\nMTG Collection Manager is ready.');
	console.log(`This computer: ${url}`);
	if (lanEnabled) {
		if (lanUrls.length > 0) {
			for (const lanUrl of lanUrls) console.log(`Other devices: ${lanUrl}`);
		} else {
			console.log('No active local-network address was detected.');
		}
		console.log('Only share these addresses with devices on your trusted local network.');
	}
	console.log('Press Ctrl+C to stop it.\n');
	openBrowser();
	if (process.env.STARTUP_CHECK === '1') stop('SIGTERM');
} catch (error) {
	console.error(error instanceof Error ? error.message : error);
	stop('SIGTERM');
}
