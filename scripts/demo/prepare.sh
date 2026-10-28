#!/usr/bin/env bash
# Prepares and records docs/assets/demo.gif. Needs vhs (https://github.com/charmbracelet/vhs) and
# the fixture shop running: `PORT=4173 pnpm --filter @site-to-api/e2e run fixture`.
# Run from the repository root: scripts/demo/prepare.sh
set -euo pipefail
root=$(pwd)
demo="$root/e2e/.output/demo"
rm -rf "${demo:?}" && mkdir -p "$demo"
pnpm run build >/dev/null
cli() { (cd "$demo" && node "$root/packages/site-to-api/bin/site-to-api.mjs" "$@"); }
cli init >/dev/null
# Two sessions captured off camera; the recording shows the third (login) and the build.
for session in browse browse-again; do
  cli capture http://localhost:4173 --headless --channel bundled --session "$session" --script "$root/e2e/scenarios/$session.ts" >/dev/null
done
cat > "$demo/demo-env.sh" <<ENV
export PS1='\$ '
# Show paths relative to the demo folder so no local user name appears in the recording.
site-to-api() { node "$root/packages/site-to-api/bin/site-to-api.mjs" "\$@" 2>&1 | sed "s#\$PWD#.#g"; }
ENV
vhs scripts/demo/demo.tape
