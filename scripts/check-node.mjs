const [major, minor] = process.versions.node.split('.').map(Number);
const supported = major > 22 || (major === 22 && minor >= 12) || (major === 20 && minor >= 19);

if (!supported) {
	console.error(`Node.js ${process.versions.node} is not supported.`);
	console.error('Install Node.js 20.19 or newer (Node.js 22 LTS recommended), then try again.');
	process.exit(1);
}

console.log(`Node.js ${process.versions.node} detected.`);
