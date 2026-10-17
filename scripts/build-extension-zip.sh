#!/usr/bin/env bash
# build-extension-zip.sh — package extension/ into web/public/oracle-solver-extension.zip
# so the Next.js site offers a real download. Re-run after changing the extension:
#   npm run build:zip
set -euo pipefail
cd "$(dirname "$0")/.."

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

mkdir -p "$STAGE/oracle-solver-extension"
cp extension/manifest.json extension/content.js extension/background.js extension/popup.html extension/popup.js "$STAGE/oracle-solver-extension/"

mkdir -p web/public
rm -f web/public/oracle-solver-extension.zip

# Use Python's zipfile (no zip binary dependency)
python3 - "$STAGE" <<'EOF'
import os, sys, zipfile
stage = sys.argv[1]
out = os.path.join(os.getcwd(), 'web', 'public', 'oracle-solver-extension.zip')
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
    for root, _, files in os.walk(os.path.join(stage, 'oracle-solver-extension')):
        for f in files:
            full = os.path.join(root, f)
            z.write(full, os.path.relpath(full, stage))
print('wrote', out)
EOF

echo "Built web/public/oracle-solver-extension.zip ($(du -h web/public/oracle-solver-extension.zip | cut -f1))"
