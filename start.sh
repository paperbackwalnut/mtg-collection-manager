#!/usr/bin/env sh
set -eu
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
	echo "Node.js is required. Install Node.js 22 LTS from https://nodejs.org/ and try again."
	exit 1
fi
node scripts/check-node.mjs

if command -v pnpm >/dev/null 2>&1; then
	PM=pnpm
elif command -v corepack >/dev/null 2>&1; then
	PM="corepack pnpm"
else
	echo "pnpm is required. Install it with: npm install --global pnpm"
	exit 1
fi

echo "Installing or checking dependencies..."
$PM install --frozen-lockfile
$PM run metadata:check
$PM start
