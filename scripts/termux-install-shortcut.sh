#!/usr/bin/env bash
set -euo pipefail

TERMUX_ROOT="/data/data/com.termux/files/usr"
if [[ ! -d "$TERMUX_ROOT" ]]; then
  echo "This script is intended for Termux. '$TERMUX_ROOT' not found." >&2
  exit 1
fi

shortcuts_dir="$HOME/.shortcuts"
if [[ ! -d "$shortcuts_dir" ]]; then
  mkdir -p "$shortcuts_dir"
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/.." && pwd)"

shortcut_path="$shortcuts_dir/FXBG-Palantir"
cat > "$shortcut_path" <<EOF
#!/usr/bin/env bash
set -euo pipefail

cd "$repo_root"
exec bash "$repo_root/scripts/termux-run.sh"
EOF

chmod +x "$shortcut_path"

echo "Now open Termux → Shortcuts → FXBG-Palantir"
