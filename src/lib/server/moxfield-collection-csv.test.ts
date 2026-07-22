import { describe, expect, it } from 'vitest';
import { parseMoxfieldCSV } from './moxfield';

const header =
	'Count,Name,Edition,Condition,Language,Foil,Tags,Collector Number,Proxy,Purchase Price';

describe('Moxfield collection CSV parsing', () => {
	it('requires identifying collection columns', () => {
		expect(parseMoxfieldCSV('Name,Count\nSol Ring,1')).toEqual([]);
	});

	it('preserves a zero purchase price and parses proxy rows', () => {
		const [row] = parseMoxfieldCSV(`${header}\n1,Sol Ring,CMR,NM,English,false,,319,true,0`);
		expect(row).toMatchObject({
			count: 1,
			edition: 'cmr',
			collectorNumber: '319',
			isProxy: true,
			purchasePrice: 0
		});
	});

	it('skips zero and negative quantities', () => {
		const csv = `${header}\n0,Island,M21,NM,English,false,,265,false,\n-1,Swamp,M21,NM,English,false,,268,false,`;
		expect(parseMoxfieldCSV(csv)).toEqual([]);
	});

	it('imports the application collection export format', () => {
		const csv =
			'Name,Set,Collector #,Foil,Condition,Qty,Assigned,Available,Price USD,Location,Type,Tags\n"Sol Ring",CMR,319,Yes,NM,2,0,2,1.25,Binder,Artifact,"favorite; commander"';
		const [row] = parseMoxfieldCSV(csv);
		expect(row).toMatchObject({
			name: 'Sol Ring',
			edition: 'cmr',
			collectorNumber: '319',
			count: 2,
			foil: true,
			isProxy: false,
			purchasePrice: null,
			tags: 'favorite,commander'
		});
	});
});
