import { createSocket } from 'node:dgram';
import { networkInterfaces } from 'node:os';
import QRCode from 'qrcode';

export type AccessInfo = {
	lanEnabled: boolean;
	localUrl: string;
	lanUrls: Array<{ url: string; qrDataUrl: string }>;
};

export async function getAccessInfo(): Promise<AccessInfo> {
	const port = Number.parseInt(process.env.PORT ?? '5173', 10);
	const host = process.env.HOST ?? '127.0.0.1';
	const lanEnabled = process.env.LAN_ACCESS === '1' || host === '0.0.0.0';
	const localUrl = `http://127.0.0.1:${port}`;

	if (!lanEnabled) return { lanEnabled, localUrl, lanUrls: [] };

	const urls = new Set<string>();
	const preferredAddress = await getPreferredLanAddress();
	if (preferredAddress && isPrivateAddress(preferredAddress)) {
		urls.add(`http://${preferredAddress}:${port}`);
	}

	for (const [name, entries] of Object.entries(networkInterfaces())) {
		if (urls.size > 0) break;
		if (/vmware|virtualbox|default switch|wsl|docker|tailscale|loopback/i.test(name)) {
			continue;
		}
		for (const entry of entries ?? []) {
			if (entry.family === 'IPv4' && !entry.internal && isPrivateAddress(entry.address)) {
				urls.add(`http://${entry.address}:${port}`);
			}
		}
	}

	const lanUrls = await Promise.all(
		[...urls].map(async (url) => ({
			url,
			qrDataUrl: await QRCode.toDataURL(url, {
				width: 220,
				margin: 2,
				color: { dark: '#171a21', light: '#ffffff' }
			})
		}))
	);

	return { lanEnabled, localUrl, lanUrls };
}

function getPreferredLanAddress(): Promise<string | null> {
	return new Promise((resolve) => {
		const socket = createSocket('udp4');
		let settled = false;
		const timeout = setTimeout(() => finish(null), 500);
		const finish = (address: string | null) => {
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

function isPrivateAddress(address: string): boolean {
	const parts = address.split('.').map(Number);
	return (
		parts.length === 4 &&
		(parts[0] === 10 ||
			(parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
			(parts[0] === 192 && parts[1] === 168))
	);
}
