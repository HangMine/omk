"""Run scoped offline checks through AdaptOrch's existing CommandVerifier.

Invoke with AdaptOrch's interpreter and PYTHONPATH, not a provider/model runtime.
The receipt records commands, source digests and outcomes, not semantic correctness.
"""
from __future__ import annotations

import argparse
import hashlib
import inspect
import json
import os
from pathlib import Path

from adaptorch.dag import TaskDAG
from adaptorch.router import TopologyRouter
from adaptorch.verification import CommandVerifier, SandboxLimits


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[2]
    files = [
        "packages/coding-agent/src/core/paper-joint-budget.ts",
        "packages/coding-agent/src/core/paper-provenance-credit.ts",
        "packages/coding-agent/src/core/paper-experience-gate.ts",
        "packages/coding-agent/src/core/verified-memory-record.ts",
        "packages/coding-agent/src/core/verified-memory-store.ts",
        "packages/coding-agent/src/core/session-memory.ts",
        "packages/coding-agent/src/commands/algorithms-cli.ts",
        "scripts/paper-algorithms/compare.ts",
    ]
    before = {name: hashlib.sha256((root / name).read_bytes()).hexdigest() for name in files}
    tests = " ".join([
        "packages/coding-agent/test/paper-joint-budget.test.ts",
        "packages/coding-agent/test/paper-provenance-credit.test.ts",
        "packages/coding-agent/test/paper-experience-gate.test.ts",
        "packages/coding-agent/test/paper-algorithms-cli.test.ts",
        "packages/coding-agent/test/verified-memory-store.test.ts",
        "packages/coding-agent/test/suite/verified-memory-wiring.test.ts",
    ])
    commands = [
        f"node node_modules/vitest/dist/cli.js --run {tests}",
        "node node_modules/@typescript/native-preview/bin/tsgo.js --noEmit",
        "node --import ./node_modules/tsx/dist/loader.mjs scripts/paper-algorithms/compare.ts",
    ]
    dag = TaskDAG.from_payload({"subtasks": [
        {"id": f"check-{index}", "description": command, "estimated_tokens": 100,
         **({"depends_on": [f"check-{index - 1}"], "coupling": "strong"} if index else {})}
        for index, command in enumerate(commands)
    ]})
    route = TopologyRouter().route(dag)
    verifier = CommandVerifier(
        commands, working_directory=root, timeout_seconds=240, sandbox_mode="host",
        inherit_environment=False, cache_results=False, output_tail_chars=1600,
        environment={"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "HOME": str(Path.home()), "LIVE_E2E": "0"},
        sandbox_limits=SandboxLimits(max_memory_bytes=None, max_cpu_time_seconds=240,
                                     max_file_size_bytes=64 * 1024**2, max_processes=None),
    )
    candidate = json.dumps(before, sort_keys=True)
    outcome = verifier.verify_candidate(candidate=candidate, candidate_index=0, candidates=(candidate,))
    after = {name: hashlib.sha256((root / name).read_bytes()).hexdigest() for name in files}
    record = {
        "schemaVersion": "omk.adaptorch-paper-verification.v1",
        "sourceManifest": before, "sourcesUnchangedDuringVerification": before == after,
        "verificationModuleSha256": hashlib.sha256(Path(inspect.getfile(CommandVerifier)).read_bytes()).hexdigest(),
        "topology": str(route.topology), "outcome": outcome.to_payload(),
        "providerCalls": 0, "isCorrectnessProof": False, "releaseAuthorized": False,
        "limitations": ["Command outcomes only", "Synthetic comparison, not paper benchmark reproduction",
                        "No live model performance claim", "No global model/skill policy activation"],
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(record, indent=2) + "\n")
    print(json.dumps({"passed": outcome.passed, "sourcesUnchanged": before == after,
                      "topology": str(route.topology), "isCorrectnessProof": False}))
    return 0 if outcome.passed and before == after else 1


if __name__ == "__main__":
    raise SystemExit(main())
