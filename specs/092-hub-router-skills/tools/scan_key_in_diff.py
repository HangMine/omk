#!/usr/bin/env python3
"""Count occurrences of the env TYPESAFE_API_KEY and of the literal key marker in the branch diff
and commit messages vs base. Reads the key from env at run time; stores no key, prefix or hash.
Prints counts only, never a value. Usage: scan_key_in_diff.py [base] (default a4d150974c)."""
import os, subprocess, sys
MARKER = "api" + "key_"  # built at run time so this file does not match itself
base = sys.argv[1] if len(sys.argv) > 1 else "a4d150974c"
key = os.environ.get("TYPESAFE_API_KEY", "")
git = lambda *a: subprocess.run(["git", *a], capture_output=True, text=True, check=True).stdout
text = git("diff", f"{base}..HEAD") + git("log", "--format=%B", f"{base}..HEAD")
full = text.count(key) if key else 0
marker = text.count(MARKER)
print(f"env_key_set={bool(key)} full_key_occurrences={full} marker_occurrences={marker}")
sys.exit(1 if full or marker or not key else 0)
