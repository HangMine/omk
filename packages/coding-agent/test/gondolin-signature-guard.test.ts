import { constants, createHash, generateKeyPairSync, privateEncrypt, sign, verify } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { VM } from "@earendil-works/gondolin";
import type { ExtensionAPI, ExtensionContext } from "open-multi-agent-kit";
import { beforeAll, describe, expect, it, vi } from "vitest";
import gondolinExtension from "../examples/extensions/gondolin/index.ts";
import { installGondolinSignatureGuard } from "../examples/extensions/gondolin/signature-guard.ts";

type PublicKey = { verify: (digest: string, signature: string, scheme?: unknown) => boolean };
type Digest = { update: (bytes: string) => Digest; digest: () => { getBytes: () => string } };
type Certificate = {
	publicKey: PublicKey;
	serialNumber: string;
	validity: { notBefore: Date; notAfter: Date };
	subject: { attributes: Array<{ name: string; value: string }> };
	signature: string;
	tbsCertificate: unknown;
	setSubject: (attributes: Certificate["subject"]["attributes"]) => void;
	setIssuer: (attributes: Certificate["subject"]["attributes"]) => void;
	setExtensions: (extensions: Array<Record<string, unknown>>) => void;
	sign: (key: unknown, digest: Digest) => void;
};
type FixtureForge = {
	asn1: { validate: (...args: unknown[]) => boolean; toDer: (object: unknown) => { getBytes: () => string } };
	pki: {
		publicKeyFromPem: (pem: string) => PublicKey;
		privateKeyFromPem: (pem: string) => unknown;
		createCertificate: () => Certificate;
	};
	md: { sha256: { create: () => Digest } };
	pss: { create: (options: Record<string, unknown>) => unknown };
	mgf: { mgf1: { create: (digest: Digest) => unknown } };
};
const requireHere = createRequire(import.meta.url);
const requireGondolin = createRequire(requireHere.resolve("@earendil-works/gondolin/package.json"));
const { caCertVerifiesLeaf } = requireGondolin(
	path.join(path.dirname(requireHere.resolve("@earendil-works/gondolin/package.json")), "dist/src/http/utils.js"),
) as { caCertVerifiesLeaf: (ca: Certificate, leaf: Certificate) => boolean };
const forge = requireGondolin("node-forge") as FixtureForge;
const message = Buffer.from("OMK synthetic signature regression; no external targets");
const hashes = {
	sha1: "2b0e03021a",
	sha256: "608648016503040201",
	sha384: "608648016503040202",
	sha512: "608648016503040203",
};
const keys = generateKeyPairSync("rsa", { modulusLength: 1024, publicExponent: 3 });
const publicKey = forge.pki.publicKeyFromPem(keys.publicKey.export({ type: "spki", format: "pem" }).toString());
const digest = createHash("sha256").update(message).digest();

function der(tag: number, bytes: Buffer): Buffer {
	if (bytes.length >= 128) throw new Error("Synthetic fixture exceeds short DER length");
	return Buffer.concat([Buffer.from([tag, bytes.length]), bytes]);
}
const sequence = (...items: Buffer[]) => der(0x30, Buffer.concat(items));
const oid = (hash: keyof typeof hashes) => der(0x06, Buffer.from(hashes[hash], "hex"));
const nullParameter = Buffer.from([0x05, 0]);
const garbage = der(0x04, Buffer.from("unconsumed nested element"));
const primitiveVectors = [
	{ name: "nonempty NULL", algorithm: sequence(oid("sha256"), der(0x05, Buffer.from("garbage"))) },
	{
		name: "unterminated OID",
		algorithm: sequence(der(0x06, Buffer.from("60864801650304020180", "hex")), nullParameter),
	},
	{
		name: "nonminimal OID",
		algorithm: sequence(der(0x06, Buffer.from("60808648016503040201", "hex")), nullParameter),
	},
];

function rawSignature(info: Buffer): Buffer {
	// Use a freshly generated, test-owned key to produce malformed encoded
	// messages deterministically. This tests the parser flaw, not an attack on
	// any service or a claim to forge signatures without the private key.
	const encoded = Buffer.concat([Buffer.from([0, 1]), Buffer.alloc(125 - info.length, 0xff), Buffer.from([0]), info]);
	return privateEncrypt({ key: keys.privateKey, padding: constants.RSA_NO_PADDING }, encoded);
}

function issueCertificate(name: string, issuer?: Certificate, keyPair = keys): Certificate {
	const cert = forge.pki.createCertificate();
	cert.publicKey = forge.pki.publicKeyFromPem(keyPair.publicKey.export({ type: "spki", format: "pem" }).toString());
	cert.serialNumber = issuer ? "02" : "01";
	cert.validity.notBefore = new Date("2026-01-01T00:00:00Z");
	cert.validity.notAfter = new Date("2030-01-01T00:00:00Z");
	cert.setSubject([{ name: "commonName", value: name }]);
	cert.setIssuer(issuer?.subject.attributes ?? cert.subject.attributes);
	cert.setExtensions([{ name: "basicConstraints", cA: !issuer }]);
	cert.sign(
		forge.pki.privateKeyFromPem(keyPair.privateKey.export({ type: "pkcs1", format: "pem" }).toString()),
		forge.md.sha256.create(),
	);
	return cert;
}

function gondolinVerifies(ca: Certificate, leaf: Certificate): boolean {
	return caCertVerifiesLeaf(ca, leaf);
}

describe("Gondolin CVE-2026-85393 runtime mitigation", () => {
	let unguardedSignatureAccepted = false;
	let unguardedCachedLeafAccepted = false;
	let ca: Certificate;
	let leaf: Certificate;
	let malformedLeaf: Certificate;
	const unguardedPrimitiveAccepted = new Map<string, boolean>();
	const nested = sequence(sequence(oid("sha256"), nullParameter, garbage), der(0x04, digest));

	beforeAll(() => {
		// Exercise the actual instance used by Gondolin before installing the
		// guard, and its actual cached-certificate verification function.
		unguardedSignatureAccepted = publicKey.verify(digest.toString("binary"), rawSignature(nested).toString("binary"));
		ca = issueCertificate("OMK synthetic CA");
		leaf = issueCertificate("fixture.invalid", ca);
		malformedLeaf = issueCertificate("fixture.invalid", ca);
		const leafDigest = createHash("sha256")
			.update(forge.asn1.toDer(malformedLeaf.tbsCertificate).getBytes(), "binary")
			.digest();
		malformedLeaf.signature = rawSignature(
			sequence(sequence(oid("sha256"), nullParameter, garbage), der(0x04, leafDigest)),
		).toString("binary");
		unguardedCachedLeafAccepted = gondolinVerifies(ca, malformedLeaf);
		for (const vector of primitiveVectors) {
			const signature = rawSignature(sequence(vector.algorithm, der(0x04, digest)));
			unguardedPrimitiveAccepted.set(
				vector.name,
				publicKey.verify(digest.toString("binary"), signature.toString("binary")),
			);
		}
		installGondolinSignatureGuard();
	});

	for (const vector of primitiveVectors) {
		it(`rejects ${vector.name} accepted by unguarded Forge and rejected by Node crypto`, () => {
			const signature = rawSignature(sequence(vector.algorithm, der(0x04, digest)));
			expect(unguardedPrimitiveAccepted.get(vector.name)).toBe(true);
			expect(verify("sha256", message, keys.publicKey, signature)).toBe(false);
			expect(() => publicKey.verify(digest.toString("binary"), signature.toString("binary"))).toThrow("DigestInfo");
		});
	}

	it("rejects the nested element accepted by unguarded node-forge, independently rejected by Node crypto", () => {
		expect(unguardedSignatureAccepted).toBe(true);
		expect(verify("sha256", message, keys.publicKey, rawSignature(nested))).toBe(false);
		expect(() => publicKey.verify(digest.toString("binary"), rawSignature(nested).toString("binary"))).toThrow(
			"DigestInfo",
		);
	});

	it("blocks the real Gondolin cached-leaf path while preserving normally issued certificates", () => {
		expect(unguardedCachedLeafAccepted).toBe(true);
		expect(gondolinVerifies(ca, malformedLeaf)).toBe(false);
		expect(gondolinVerifies(ca, leaf)).toBe(true);
		expect(gondolinVerifies(issueCertificate("Different issuer"), leaf)).toBe(false);
	});

	it("preserves Gondolin's default 2048-bit RSA exponent 65537 certificate path", () => {
		const defaults = generateKeyPairSync("rsa", { modulusLength: 2048, publicExponent: 65537 });
		const issuer = issueCertificate("Default synthetic CA", undefined, defaults);
		expect(gondolinVerifies(issuer, issueCertificate("fixture.invalid", issuer, defaults))).toBe(true);
	});

	for (const hash of Object.keys(hashes) as Array<keyof typeof hashes>) {
		for (const includeNull of [true, false]) {
			it(`preserves ${hash} PKCS#1 signatures with NULL=${includeNull}`, () => {
				const bytes = createHash(hash).update(message).digest();
				const algorithm = sequence(oid(hash), ...(includeNull ? [nullParameter] : []));
				expect(
					publicKey.verify(
						bytes.toString("binary"),
						rawSignature(sequence(algorithm, der(0x04, bytes))).toString("binary"),
					),
				).toBe(true);
			});
		}
	}

	for (const includeNull of [true, false]) {
		for (const extra of [...(includeNull ? [nullParameter] : []), garbage, sequence(garbage)]) {
			it(`rejects nested extra tag ${extra[0]} with NULL=${includeNull}`, () => {
				const algorithm = sequence(oid("sha256"), ...(includeNull ? [nullParameter] : []), extra);
				expect(() =>
					publicKey.verify(
						digest.toString("binary"),
						rawSignature(sequence(algorithm, der(0x04, digest))).toString("binary"),
					),
				).toThrow("DigestInfo");
			});
		}
	}

	it("retains rejection of outer garbage, trailing DER bytes, bad padding and changed messages", () => {
		const info = sequence(sequence(oid("sha256"), nullParameter), der(0x04, digest));
		const outer = sequence(sequence(oid("sha256"), nullParameter), der(0x04, digest), garbage);
		expect(() => publicKey.verify(digest.toString("binary"), rawSignature(outer).toString("binary"))).toThrow();
		expect(() =>
			publicKey.verify(
				digest.toString("binary"),
				rawSignature(Buffer.concat([info, Buffer.from([0])])).toString("binary"),
			),
		).toThrow();
		expect(() => publicKey.verify(digest.toString("binary"), Buffer.alloc(128).toString("binary"))).toThrow();
		expect(publicKey.verify(Buffer.alloc(32).toString("binary"), rawSignature(info).toString("binary"))).toBe(false);
	});

	it("preserves RSA-PSS verification", () => {
		const signature = sign("sha256", message, {
			key: keys.privateKey,
			padding: constants.RSA_PKCS1_PSS_PADDING,
			saltLength: 32,
		});
		const scheme = forge.pss.create({
			md: forge.md.sha256.create(),
			mgf: forge.mgf.mgf1.create(forge.md.sha256.create()),
			saltLength: 32,
		});
		expect(publicKey.verify(digest.toString("binary"), signature.toString("binary"), scheme)).toBe(true);
	});

	it("is idempotent and refuses a replaced validator", () => {
		const guarded = forge.asn1.validate;
		expect(() => installGondolinSignatureGuard()).not.toThrow();
		forge.asn1.validate = () => true;
		try {
			expect(() => installGondolinSignatureGuard()).toThrow("validator was replaced");
		} finally {
			forge.asn1.validate = guarded;
		}
	});

	it("refuses an unreviewed dependency before touching its validator", () => {
		const directory = mkdtempSync(path.join(tmpdir(), "omk-forge-drift-"));
		const source = path.join(directory, "rsa.js");
		writeFileSync(source, "unreviewed implementation");
		const dependency = Object.assign(() => ({ version: "1.4.0" }), {
			resolve: () => source,
		}) as unknown as NodeJS.Require;
		try {
			expect(() => installGondolinSignatureGuard(dependency)).toThrow("unreviewed node-forge");
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("installs the guard on the real extension startup path before VM.create", async () => {
		const callbacks = new Map<string, (event: unknown, context: ExtensionContext) => Promise<void>>();
		gondolinExtension({
			on: (event: string, callback: unknown) =>
				callbacks.set(event, callback as (event: unknown, context: ExtensionContext) => Promise<void>),
			registerTool: () => {},
			registerCommand: () => {},
		} as unknown as ExtensionAPI);
		const context = {
			ui: { setStatus: () => {}, theme: { fg: (_color: string, text: string) => text } },
		} as unknown as ExtensionContext;
		const create = vi.spyOn(VM, "create").mockImplementation(async () => {
			expect(gondolinVerifies(ca, malformedLeaf)).toBe(false);
			throw new Error("Synthetic VM stop: no hypervisor or network started");
		});
		try {
			await expect(callbacks.get("session_start")?.({}, context)).rejects.toThrow("Synthetic VM stop");
			expect(create).toHaveBeenCalledOnce();
			create.mockClear();
			const guarded = forge.asn1.validate;
			forge.asn1.validate = () => true;
			try {
				await expect(callbacks.get("session_start")?.({}, context)).rejects.toThrow("validator was replaced");
				expect(create).not.toHaveBeenCalled();
			} finally {
				forge.asn1.validate = guarded;
			}
		} finally {
			create.mockRestore();
		}
	});
});
