export function parseUnmodifiedKittyPrintableCodepoint(sequence: string): number | undefined {
	const match = sequence.match(/^\x1b\[(\d+)(?::\d*)?(?::\d+)?u$/);
	if (!match) return undefined;
	const codepoint = parseInt(match[1]!, 10);
	return codepoint >= 32 ? codepoint : undefined;
}
