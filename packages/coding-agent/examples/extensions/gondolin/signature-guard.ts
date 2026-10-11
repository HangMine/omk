import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

type Asn1Object = { value: string | Asn1Object[] };
type Validator = { name?: string };
type Validate = (
	object: Asn1Object,
	validator: Validator,
	capture?: Record<string, unknown>,
	errors?: string[],
) => boolean;
type Forge = {
	asn1: {
		validate: Validate;
		derToOid: (bytes: string) => string;
		oidToDer: (oid: string) => { getBytes: () => string };
	};
};

// Reviewed registry node-forge 1.4.0 lib/rsa.js. A future dependency change must
// be reviewed and tested rather than silently invalidating this temporary fix.
const REVIEWED_RSA_SHA256 = "fd4740238145ec26470eb3f06a627c72039538ce1307dbdce40521f94dfd0a50";
const REVIEWED_ASN1_SHA256 = "271047be6eab614060ef361cce2c8a92abf066c40fb329f44cfac3269214b912";
const installed = new WeakMap<Forge["asn1"], Validate>();

/**
 * Apply the nested DigestAlgorithm element-count check proposed upstream in
 * digitalbazaar/forge#1152, to the exact CJS instance Gondolin imports.
 * No installation script or on-disk dependency mutation is required.
 * The registry version remains vulnerable in npm audit; this is a scoped
 * runtime mitigation for the OMK example, not an upstream patched release.
 */
export function installGondolinSignatureGuard(
	requireFromGondolin = createRequire(createRequire(import.meta.url).resolve("@earendil-works/gondolin/package.json")),
): void {
	const metadata = requireFromGondolin("node-forge/package.json") as { version?: unknown };
	const rsaSource = readFileSync(requireFromGondolin.resolve("node-forge/lib/rsa.js"));
	if (metadata.version !== "1.4.0" || createHash("sha256").update(rsaSource).digest("hex") !== REVIEWED_RSA_SHA256) {
		throw new Error("Gondolin signature guard: unreviewed node-forge implementation; refusing VM startup");
	}
	const asn1Source = readFileSync(requireFromGondolin.resolve("node-forge/lib/asn1.js"));
	if (createHash("sha256").update(asn1Source).digest("hex") !== REVIEWED_ASN1_SHA256) {
		throw new Error("Gondolin signature guard: unreviewed ASN.1 implementation; refusing VM startup");
	}
	const forge = requireFromGondolin("node-forge") as Forge;
	if (typeof forge.asn1?.validate !== "function") {
		throw new Error("Gondolin signature guard: unsupported ASN.1 validator; refusing VM startup");
	}
	const previous = installed.get(forge.asn1);
	if (previous) {
		if (forge.asn1.validate !== previous) {
			throw new Error("Gondolin signature guard: validator was replaced; refusing VM startup");
		}
		return;
	}

	const original = forge.asn1.validate;
	const guarded: Validate = (object, validator, capture, errors) => {
		const captured = capture ?? {};
		if (!original(object, validator, captured, errors)) return false;
		if (validator.name !== "DigestInfo") return true;
		const children = object.value;
		const algorithm = Array.isArray(children) ? children[0]?.value : undefined;
		// asn1.validate permits unconsumed children. Check both levels after its
		// existing type/OID/NULL checks, preserving optional SHA NULL parameters.
		let valid =
			Array.isArray(children) &&
			children.length === 2 &&
			Array.isArray(algorithm) &&
			algorithm.length === ("parameters" in captured ? 2 : 1);
		if (valid && Array.isArray(algorithm)) {
			// NULL must be empty. OID decoding otherwise also accepts an
			// unterminated or nonminimal suffix, leaving another garbage slot.
			const encodedOid = algorithm[0]?.value;
			try {
				valid =
					typeof encodedOid === "string" &&
					forge.asn1.oidToDer(forge.asn1.derToOid(encodedOid)).getBytes() === encodedOid &&
					(!("parameters" in captured) || algorithm[1]?.value === "");
			} catch {
				valid = false;
			}
		}
		if (!valid) errors?.push("DigestInfo contains unconsumed or malformed values (CVE-2026-85393)");
		return valid;
	};
	forge.asn1.validate = guarded;
	installed.set(forge.asn1, guarded);
}
