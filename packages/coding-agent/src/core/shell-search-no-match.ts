/**
 * Spec 071 loop guard, rule 3 no-match exception: a bash `grep`/`egrep`/`fgrep`/`rg` whose
 * command's last stage exits 1 with empty output found nothing; it is not an error.
 * grep and rg both exit 1 for "no match" and 2 for an error. Any output or other exit code
 * is still an error. Callers pass only error results.
 */

/** Bash error texts for exit code 1 with no output (current tool, and older logs without the placeholder). */
const NO_MATCH_TEXTS = new Set(["Command exited with code 1", "(no output)\n\nCommand exited with code 1"]);
/** grep and rg both exit 1 for "no match" and 2 for an error. */
const SEARCH_PROGRAMS = new Set(["grep", "egrep", "fgrep", "rg"]);

/** The last stage of a shell command: text after the last unquoted `|`, `||`, `&&`, `&`, `;` or newline. */
export function lastShellStage(command: string): string {
	let quote: string | undefined;
	let start = 0;
	let last = "";
	for (let index = 0; index < command.length; index += 1) {
		const char = command[index];
		if (char === "\\" && quote !== "'") {
			index += 1;
			continue;
		}
		if (quote) {
			if (char === quote) quote = undefined;
			continue;
		}
		if (char === "'" || char === '"') quote = char;
		else if (
			char === "&" &&
			(command[index - 1] === ">" || command[index - 1] === "<" || command[index + 1] === ">")
		) {
			// Redirection (`2>&1`, `&>file`), not a separator.
		} else if (char === "|" || char === "&" || char === ";" || char === "\n") {
			const stage = command.slice(start, index).trim();
			if (stage) last = stage;
			start = index + 1;
		}
	}
	const tail = command.slice(start).trim();
	return tail || last;
}

/** spec 071 rule 3 no-match exception: bash grep/rg with exit 1 and empty output does not count toward same_error. */
export function isSearchNoMatch(toolName: string, args: unknown, errorText: string): boolean {
	if (toolName !== "bash" || !NO_MATCH_TEXTS.has(errorText.trim())) return false;
	const command = (args as { command?: unknown } | undefined)?.command;
	if (typeof command !== "string") return false;
	const words = lastShellStage(command).split(/\s+/).filter(Boolean);
	const program = words.find((word) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word));
	return program !== undefined && SEARCH_PROGRAMS.has(program.slice(program.lastIndexOf("/") + 1));
}
