import { describe, expect, it } from 'vitest';
import {
	legacyProxyPrintState,
	nextProxyPrintStatus,
	proxyInventoryDetailsError,
	proxyInventoryAssignmentState,
	proxyReleaseError,
	proxyReservationError
} from './proxy-inventory';

describe('legacy proxy inventory backfill', () => {
	it('treats printed proxy assignments as ready physical copies', () => {
		expect(legacyProxyPrintState({ status: 'proxied', printStatus: null })).toBe('ready');
	});

	it('preserves the physical copy behind a reprint request', () => {
		expect(legacyProxyPrintState({ status: 'proxied', printStatus: 'need_reprint' })).toBe(
			'needs_reprint'
		);
	});

	it('does not invent inventory for cards that still need printing', () => {
		expect(legacyProxyPrintState({ status: 'proxied', printStatus: 'need_print' })).toBeNull();
	});

	it('ignores non-proxy assignments even if they carry stale print metadata', () => {
		expect(legacyProxyPrintState({ status: 'assigned', printStatus: 'need_reprint' })).toBeNull();
	});
});

describe('proxy inventory assignment state', () => {
	it('derives availability from the assignment link', () => {
		expect(proxyInventoryAssignmentState(null, null)).toBe('available');
	});

	it('distinguishes reserved copies from copies packed in a deck', () => {
		expect(proxyInventoryAssignmentState(4, false)).toBe('reserved');
		expect(proxyInventoryAssignmentState(4, true)).toBe('in_deck');
	});
});

describe('proxy inventory reservation rules', () => {
	it('accepts an unlinked proxy assignment for the same card', () => {
		expect(
			proxyReservationError('Sol Ring', {
				cardName: 'sol ring',
				status: 'proxied',
				proxyInventoryId: null
			})
		).toBeNull();
	});

	it('rejects non-proxy, already-linked, and wrong-card assignments', () => {
		expect(
			proxyReservationError('Sol Ring', {
				cardName: 'Sol Ring',
				status: 'assigned',
				proxyInventoryId: null
			})
		).toMatch(/Only proxy/);
		expect(
			proxyReservationError('Sol Ring', {
				cardName: 'Sol Ring',
				status: 'proxied',
				proxyInventoryId: 12
			})
		).toMatch(/already has/);
		expect(
			proxyReservationError('Sol Ring', {
				cardName: 'Arcane Signet',
				status: 'proxied',
				proxyInventoryId: null
			})
		).toMatch(/same card/);
	});

	it('requires a packed copy to be unpacked before release', () => {
		expect(proxyReleaseError(true)).toMatch(/Unpack/);
		expect(proxyReleaseError(false)).toBeNull();
	});
});

describe('proxy inventory details', () => {
	it('accepts a complete printing or no printing', () => {
		expect(
			proxyInventoryDetailsError({
				setCode: 'cmm',
				collectorNumber: '396',
				printState: 'ready'
			})
		).toBeNull();
		expect(
			proxyInventoryDetailsError({
				setCode: null,
				collectorNumber: null,
				printState: 'needs_reprint'
			})
		).toBeNull();
	});

	it('rejects partial printing identity and invalid state', () => {
		expect(
			proxyInventoryDetailsError({
				setCode: 'cmm',
				collectorNumber: null,
				printState: 'ready'
			})
		).toMatch(/provided together/);
		expect(
			proxyInventoryDetailsError({
				setCode: null,
				collectorNumber: null,
				printState: 'lost'
			})
		).toMatch(/Invalid/);
	});
});

describe('proxy fulfillment transitions', () => {
	it('marks a newly proxied assignment as needing a physical print', () => {
		expect(
			nextProxyPrintStatus({
				currentStatus: 'assigned',
				currentPrintStatus: null,
				hasInventory: false,
				nextStatus: 'proxied'
			})
		).toBe('need_print');
	});

	it('preserves an existing proxy flag and honors an explicit replacement', () => {
		expect(
			nextProxyPrintStatus({
				currentStatus: 'proxied',
				currentPrintStatus: 'need_reprint',
				hasInventory: true,
				nextStatus: 'proxied'
			})
		).toBe('need_reprint');
		expect(
			nextProxyPrintStatus({
				currentStatus: 'proxied',
				currentPrintStatus: 'need_reprint',
				hasInventory: true,
				nextStatus: 'proxied',
				requestedPrintStatus: null
			})
		).toBeNull();
	});

	it('cannot clear the print task without a linked physical proxy', () => {
		expect(
			nextProxyPrintStatus({
				currentStatus: 'proxied',
				currentPrintStatus: 'need_print',
				hasInventory: false,
				nextStatus: 'proxied',
				requestedPrintStatus: null
			})
		).toBe('need_print');
	});

	it('clears proxy-only print state for every other fulfillment type', () => {
		for (const status of ['assigned', 'needed', 'ordered', 'unassigned']) {
			expect(
				nextProxyPrintStatus({
					currentStatus: 'proxied',
					currentPrintStatus: 'need_print',
					hasInventory: false,
					nextStatus: status
				})
			).toBeNull();
		}
	});
});
