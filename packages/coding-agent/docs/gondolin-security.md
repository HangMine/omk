# Gondolin signature security

OMK 1.4.0's optional Gondolin example mitigates
[CVE-2026-85393 / GHSA-86w9-cpqp-85rv](https://github.com/advisories/GHSA-86w9-cpqp-85rv)
before every VM start. The registry's `node-forge` 1.4.0 remains affected;
there is no official patched release at the time of this change. This is a
temporary OMK runtime fix, not a claim that the upstream package is patched.

## Cause and actual path

RSA PKCS#1 v1.5 signatures contain an ASN.1 `DigestInfo` with a nested
`DigestAlgorithm`. Forge's validator consumes the expected fields but ignores
extra children. Version 1.4.0 checks the outer count and misses the nested count,
allowing malformed signatures; the advisory describes low-exponent RSA forgery.

Gondolin calls `caCert.verify(leafCert)` while reading cached local MITM leaf
certificates. The cache is checked against its local CA. External server TLS
verification uses Node/Undici, not this Forge verification function. The seven
public core package manifests and CLI shrinkwrap exclude Gondolin/Forge;
the separately installed example depends on them. Gondolin's generated CA
uses exponent 65537, but persisted CA material has no exponent restriction.

## Mitigation

[`signature-guard.ts`](../examples/extensions/gondolin/signature-guard.ts) loads
the exact CommonJS Forge instance resolved from Gondolin's package directory.
It adds the nested count check proposed in
[upstream PR #1152](https://github.com/digitalbazaar/forge/pull/1152): only the OID
and optional NULL parameter may occur inside `DigestAlgorithm`, and the outer
`DigestInfo` must contain exactly its algorithm and digest. Local boundary
regressions additionally reproduced acceptance of nonempty NULL, unterminated
OID and nonminimal OID values; the guard requires empty NULL and canonical OID
encoding to close those primitive-value garbage slots too. Existing type,
OID, digest, padding and trailing-byte checks remain active. SHA signatures
with and without NULL parameters and RSA-PSS retain their existing behavior.

The example and root override pin Forge 1.4.0. Startup requires its reviewed
`lib/rsa.js` and `lib/asn1.js` SHA256 values and rejects a changed version, changed implementation or
replaced guard. No lifecycle script or on-disk library patch is needed, so
`npm install --ignore-scripts` still installs a usable guarded example.
Copy the entire example directory and load its `index.ts` through OMK.
Previously copied extensions must also be updated while preserving local
customizations; upgrading the CLI alone does not replace those copies.

This fix covers the OMK example's process. It does not patch a separately
launched `gondolin` CLI, another application, or trusted extension code that
deliberately modifies the process. Keep certificate caches private to their
owner and do not import untrusted CA keys. No live service was attacked.

## Reproducible evidence

From `packages/coding-agent`:

```bash
node ../../node_modules/vitest/dist/cli.js --run test/gondolin-signature-guard.test.ts
```

The suite generates disposable synthetic RSA keys in memory. A test-owned
private key constructs malformed encoded messages; this demonstrates the
verification flaw, not private-key-free exploit generation. Unguarded Forge
and Gondolin's actual cached-leaf verification accept the nested extra element;
the guarded instance and Node's independent crypto verifier reject it.
Normally issued certificates, default 2048-bit/exponent-65537 CA material,
SHA1/256/384/512 with optional NULL, and RSA-PSS pass. Nested and outer garbage,
nonempty NULL, unterminated or nonminimal OID,
bad padding, trailing bytes, changed messages, issuer mismatch, dependency
drift and guard replacement fail. A mocked VM startup verifies the real
extension installs the guard before `VM.create`; no hypervisor or network runs.

`npm audit --omit=dev --audit-level=moderate` still reports the upstream advisory
under Forge and Gondolin and exits nonzero. No audit threshold, ignored advisory,
dependency classification or security workflow changed. Test results provide
evidence for this specific path; they do not prove absence of all vulnerabilities.

## Maintenance

When an official patch is available, review the published source and advisory,
update the pin, rerun this regression suite and full CI, then remove the runtime
guard only after the unguarded dependency rejects the malformed fixture.
Until then, dependency changes intentionally require a new guard review.
