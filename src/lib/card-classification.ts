/** True when every face of a card's type line is a land face. */
export function isLandOnlyTypeLine(typeLine: string): boolean {
	const faces = typeLine
		.split('//')
		.map((face) => face.trim().toLowerCase())
		.filter(Boolean);

	return faces.length > 0 && faces.every((face) => face.includes('land'));
}
