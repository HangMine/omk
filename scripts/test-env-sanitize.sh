# shellcheck shell=bash
# Sourced by test.sh before `npm test`. test.sh promises a run without credentials, and
# scripts/release.mjs:366 and scripts/local-release.mjs:222 gate releases on it, so no
# credential may reach a test process. A name list alone kept missing keys (f268119c7a
# added eight provider keys, a later fix eight service keys), so every variable whose
# name contains KEY, SECRET, TOKEN or PASSWORD (any case) is removed. A variable the
# suite truly needs comes back only through TEST_SH_ENV_ALLOWLIST below, and each entry is
# justified with file:line in the PR body that adds it.

# Named allowlist. Empty: nothing the suite runs needs a matching variable from the caller.
TEST_SH_ENV_ALLOWLIST=()

# Credential-bearing names that the pattern does not catch.
TEST_SH_ENV_EXTRA_NAMES=(
	AWS_ACCESS_KEY_ID
	GOOGLE_APPLICATION_CREDENTIALS
	AWS_PROFILE
	AZURE_OPENAI_ENDPOINT
)

test_sh_env_allowed() {
	local candidate
	for candidate in "${TEST_SH_ENV_ALLOWLIST[@]}"; do
		[ "$candidate" = "$1" ] && return 0
	done
	return 1
}

test_sh_sanitize_env() {
	local entry name upper
	while IFS= read -r -d '' entry; do
		name=${entry%%=*}
		[[ "$name" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || continue
		upper=${name^^}
		case "$upper" in
		*KEY* | *SECRET* | *TOKEN* | *PASSWORD*)
			test_sh_env_allowed "$name" || unset "$name"
			;;
		esac
	done < <(env -0)
	for name in "${TEST_SH_ENV_EXTRA_NAMES[@]}"; do
		test_sh_env_allowed "$name" || unset "$name"
	done
}

test_sh_sanitize_env
