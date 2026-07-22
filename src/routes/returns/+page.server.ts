import type { Actions, PageServerLoad } from './$types';
import { fail } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import {
	cardAssignments,
	collection,
	deckPendingRemovals,
	deckPendingReturnAssignments,
	decks
} from '$lib/server/db/schema';
import { getByIds, getByName, getBySetColl } from '$lib/server/db/scryfall-sqlite';
import { applyPendingRemovals } from '$lib/server/deck-workspace';
import { LOCATION_LABELS, type CardLocation } from '$lib/types';
import { eq } from 'drizzle-orm';

export type ReturnQueueCopy = {
	assignmentId: number;
	kind: 'owned' | 'proxy' | 'unknown';
	printing: string | null;
	destination: CardLocation;
	destinationLabel: string;
};

export type ReturnQueueTask = {
	id: number;
	deckId: number;
	deckName: string;
	deckCardId: number;
	cardName: string;
	board: string;
	targetQuantity: number;
	detectedAt: number;
	imageUri: string | null;
	copies: ReturnQueueCopy[];
};

export type ReturnQueueGroup = {
	deckId: number;
	deckName: string;
	tasks: ReturnQueueTask[];
	copyCount: number;
};

export const load: PageServerLoad = async () => {
	const rows = await db
		.select({
			pendingId: deckPendingRemovals.id,
			deckId: deckPendingRemovals.deckId,
			deckName: decks.name,
			deckCardId: deckPendingRemovals.deckCardId,
			cardName: deckPendingRemovals.cardName,
			board: deckPendingRemovals.board,
			targetQuantity: deckPendingRemovals.targetQuantity,
			detectedAt: deckPendingRemovals.detectedAt,
			assignmentId: deckPendingReturnAssignments.assignmentId,
			status: cardAssignments.status,
			proxySetCode: cardAssignments.proxySetCode,
			proxyCollectorNumber: cardAssignments.proxyCollectorNumber,
			collScryfallId: collection.scryfallId,
			collSetCode: collection.setCode,
			collCollectorNumber: collection.collectorNumber,
			collFoil: collection.foil,
			collCondition: collection.condition
		})
		.from(deckPendingRemovals)
		.innerJoin(decks, eq(deckPendingRemovals.deckId, decks.id))
		.leftJoin(
			deckPendingReturnAssignments,
			eq(deckPendingReturnAssignments.pendingRemovalId, deckPendingRemovals.id)
		)
		.leftJoin(cardAssignments, eq(deckPendingReturnAssignments.assignmentId, cardAssignments.id))
		.leftJoin(collection, eq(cardAssignments.collectionId, collection.id));

	const scryfallById = getByIds(rows.map((row) => row.collScryfallId));
	const tasks = new Map<number, ReturnQueueTask>();

	for (const row of rows) {
		let task = tasks.get(row.pendingId);
		if (!task) {
			task = {
				id: row.pendingId,
				deckId: row.deckId,
				deckName: row.deckName,
				deckCardId: row.deckCardId,
				cardName: row.cardName,
				board: row.board,
				targetQuantity: row.targetQuantity,
				detectedAt: row.detectedAt,
				imageUri: null,
				copies: []
			};
			tasks.set(row.pendingId, task);
		}
		if (row.assignmentId == null) continue;

		const ownedCard = row.collScryfallId ? scryfallById.get(row.collScryfallId) : undefined;
		const proxyCard =
			row.proxySetCode && row.proxyCollectorNumber
				? getBySetColl(row.proxySetCode, row.proxyCollectorNumber)
				: undefined;
		const cardData = ownedCard ?? proxyCard ?? getByName(row.cardName);
		task.imageUri ??= cardData?.image_uri ?? null;

		let kind: ReturnQueueCopy['kind'] = 'unknown';
		let destination: CardLocation = 'unknown';
		if (row.status === 'assigned') {
			kind = 'owned';
			destination = 'holding_box';
		} else if (row.status === 'proxied') {
			kind = 'proxy';
			destination = 'proxy_box';
		}

		const printing = row.collSetCode
			? `${row.collSetCode.toUpperCase()} #${row.collCollectorNumber}${row.collFoil ? ' F' : ''}${row.collCondition && row.collCondition !== 'NM' ? ` · ${row.collCondition}` : ''}`
			: row.proxySetCode
				? `${row.proxySetCode.toUpperCase()} #${row.proxyCollectorNumber}`
				: null;

		task.copies.push({
			assignmentId: row.assignmentId,
			kind,
			printing,
			destination,
			destinationLabel: LOCATION_LABELS[destination]
		});
	}

	for (const task of tasks.values()) {
		if (!task.imageUri) task.imageUri = getByName(task.cardName)?.image_uri ?? null;
	}

	const groupsByDeck = new Map<number, ReturnQueueGroup>();
	for (const task of [...tasks.values()].sort(
		(left, right) =>
			left.deckName.localeCompare(right.deckName) || left.cardName.localeCompare(right.cardName)
	)) {
		const group = groupsByDeck.get(task.deckId) ?? {
			deckId: task.deckId,
			deckName: task.deckName,
			tasks: [],
			copyCount: 0
		};
		group.tasks.push(task);
		group.copyCount += Math.max(1, task.copies.length);
		groupsByDeck.set(task.deckId, group);
	}

	const groups = [...groupsByDeck.values()];
	return {
		groups,
		taskCount: tasks.size,
		copyCount: groups.reduce((total, group) => total + group.copyCount, 0)
	};
};

function parseTasks(data: FormData): Array<{ deckId: number; pendingRemovalId: number }> {
	const parsed = data.getAll('task').map((value) => {
		const [deckId, pendingRemovalId] = String(value).split(':').map(Number);
		return { deckId, pendingRemovalId };
	});
	if (
		parsed.length === 0 ||
		parsed.some(
			(task) =>
				!Number.isInteger(task.deckId) ||
				task.deckId <= 0 ||
				!Number.isInteger(task.pendingRemovalId) ||
				task.pendingRemovalId <= 0
		)
	) {
		throw new Error('Select at least one valid return task.');
	}
	return parsed;
}

export const actions: Actions = {
	complete: async ({ request }) => {
		try {
			const completed = await applyPendingRemovals(parseTasks(await request.formData()));
			return { completed };
		} catch (cause) {
			return fail(409, {
				error: cause instanceof Error ? cause.message : 'Could not complete return tasks.'
			});
		}
	}
};
