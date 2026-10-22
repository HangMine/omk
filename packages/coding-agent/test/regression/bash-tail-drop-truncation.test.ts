import { describe, it } from "vitest";

// KNOWN BUG (found while deflaking spec 106 D1 test, PR after #214; fix scheduled first after the 10/23 12:00 KST freeze):
// src/core/bash-executor.ts executeBashWithOperations keeps only the last maxOutputBytes (100 KB) by dropping whole
// leading chunks. A single 120 KB line delivered as ~78 KB + ~42 KB keeps only 42 KB; truncateTail then sees < 50 KB
// on one line and returns truncated: false with no fullOutputPath, so ~78 KB is silently lost and the model believes
// it saw the full output. Expected: truncated: true and the spill file kept whenever leading chunks were dropped.
describe("bash executor tail-drop truncation (known bug)", () => {
	it.todo(
		"reports truncated: true and keeps the spill file when leading chunks are dropped (78 KB + 42 KB single line)",
	);
});
