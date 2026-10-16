/** Code-point class predicates for the fallback token estimator (moved from text-token-estimate.ts). */

/** Exactly the code points `/\s/u` matches: ECMAScript WhiteSpace and LineTerminator. */
export function isUnicodeWhitespace(codePoint: number): boolean {
	if (codePoint <= 0x20) return codePoint === 0x20 || (codePoint >= 0x09 && codePoint <= 0x0d);
	if (codePoint < 0xa0) return false;
	return (
		codePoint === 0xa0 ||
		codePoint === 0x1680 ||
		(codePoint >= 0x2000 && codePoint <= 0x200a) ||
		codePoint === 0x2028 ||
		codePoint === 0x2029 ||
		codePoint === 0x202f ||
		codePoint === 0x205f ||
		codePoint === 0x3000 ||
		codePoint === 0xfeff
	);
}

export function isAsciiAlphaNumeric(codePoint: number): boolean {
	return (
		(codePoint >= 48 && codePoint <= 57) ||
		(codePoint >= 65 && codePoint <= 90) ||
		(codePoint >= 97 && codePoint <= 122)
	);
}

export function isAsciiPunctuation(codePoint: number): boolean {
	return codePoint >= 33 && codePoint <= 126;
}

export function isHangul(codePoint: number): boolean {
	// Composed syllables (가-힣)
	if (codePoint >= 0xac00 && codePoint <= 0xd7af) return true;
	// Jamo: initial (ㄱ-ㅎ), medial (ㅏ-ㅣ)
	if (codePoint >= 0x1100 && codePoint <= 0x11ff) return true;
	// Compatibility jamo (ㄱ-ㅎ, ㅏ-ㅣ) and Hangul letters
	if (codePoint >= 0x3130 && codePoint <= 0x318f) return true;
	// Extended jamo
	if (codePoint >= 0xa960 && codePoint <= 0xa97c) return true;
	return false;
}

export function isHiraganaOrKatakana(codePoint: number): boolean {
	// Hiragana (ぁ-より)
	if (codePoint >= 0x3040 && codePoint <= 0x309f) return true;
	// Katakana (ァ-ヿ) + halfwidth katakana
	if (codePoint >= 0x30a0 && codePoint <= 0x30ff) return true;
	if (codePoint >= 0xff65 && codePoint <= 0xff9f) return true;
	return false;
}

export function isCjkIdeograph(codePoint: number): boolean {
	// CJK Unified Ideographs (main block: 中, 国, etc.)
	if (codePoint >= 0x4e00 && codePoint <= 0x9fff) return true;
	// CJK Extension A (rare)
	if (codePoint >= 0x3400 && codePoint <= 0x4dbf) return true;
	// CJK compatibility ideographs
	if (codePoint >= 0xf900 && codePoint <= 0xfaff) return true;
	return false;
}

export function isEmojiOrWideSymbol(codePoint: number): boolean {
	// Main emoji blocks
	if (codePoint >= 0x1f000) return true;
	// Misc symbols, dingbats
	if (codePoint >= 0x2600 && codePoint <= 0x27bf) return true;
	// CJK fullwidth/special forms that occupy double width
	if (codePoint >= 0xff01 && codePoint <= 0xff60) return true;
	if (codePoint >= 0xffe0 && codePoint <= 0xffe6) return true;
	return false;
}
