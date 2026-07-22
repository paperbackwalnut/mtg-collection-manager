export interface ActiveOracleTagToken {
	start: number;
	end: number;
	prefix: string;
	query: string;
}

/**
 * Find an unfinished otag:/oracle-tag: token immediately before the cursor.
 * Completed quoted tokens are intentionally ignored.
 */
export function findActiveOracleTagToken(
	value: string,
	cursor: number
): ActiveOracleTagToken | null {
	const beforeCursor = value.slice(0, cursor);
	const match = beforeCursor.match(/(?:^|\s)(-?(?:otag|oracle-tag):)(?:"([^"]*)|([^\s"]*))$/i);
	if (!match) return null;

	const leadingSpace = match[0].startsWith(' ') ? 1 : 0;
	const start = cursor - match[0].length + leadingSpace;
	let end = cursor;
	while (end < value.length && !/\s/.test(value[end])) end++;

	return {
		start,
		end,
		prefix: match[1],
		query: match[2] ?? match[3] ?? ''
	};
}

export function replaceActiveOracleTagToken(
	value: string,
	active: ActiveOracleTagToken,
	label: string
): { value: string; cursor: number } {
	const escapedLabel = label.replace(/"/g, '\\"');
	const replacement = `${active.prefix}"${escapedLabel}"`;
	const nextValue = value.slice(0, active.start) + replacement + value.slice(active.end);
	return {
		value: nextValue,
		cursor: active.start + replacement.length
	};
}
