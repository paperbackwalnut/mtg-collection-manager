/** Server-backed Shopping List — wraps /api/shopping-list */

export type ShoppingItem = {
	id: number;
	cardName: string;
	quantity: number;
	notes: string | null;
	source: string | null;
	addedAt: number;
	updatedAt: number;
};

export async function getItems(): Promise<ShoppingItem[]> {
	const res = await fetch('/api/shopping-list');
	if (!res.ok) return [];
	return res.json();
}

/**
 * Add a card to the list. If it already exists, quantity is increased by `qty`.
 * Safe to call in bulk — duplicates accumulate qty, never create a new row.
 */
export async function addItem(cardName: string, qty = 1, source?: string): Promise<void> {
	await fetch('/api/shopping-list', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ cardName, quantity: qty, source })
	});
}

export async function removeItem(cardName: string): Promise<void> {
	await fetch('/api/shopping-list', {
		method: 'DELETE',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ cardName })
	});
}

export async function updateItem(
	cardName: string,
	patch: { quantity?: number; notes?: string }
): Promise<void> {
	await fetch('/api/shopping-list', {
		method: 'PATCH',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ cardName, ...patch })
	});
}

export async function clearAll(): Promise<void> {
	await fetch('/api/shopping-list', {
		method: 'DELETE',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ all: true })
	});
}
