#!/usr/bin/env bash
# Installs the fengguang skill into an agent's skills directory.
#
#   ./install.sh                                    # -> ~/.dsh/skills/fengguang
#   ./install.sh ~/.claude/skills
#   ./install.sh ~/.dsh/skills my-fengguang
#
# The directory name becomes the skill name; SKILL.md must stay at its root.

set -euo pipefail

TARGET="${1:-$HOME/.dsh/skills}"
NAME="${2:-fengguang}"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DST="$TARGET/$NAME"

if [ ! -f "$SRC/SKILL.md" ]; then
  echo "error: SKILL.md not found next to install.sh — run this from the skill repo root." >&2
  exit 1
fi

if [ -e "$DST" ]; then
  BACKUP="$DST.bak.$(date +%Y%m%d%H%M%S)"
  echo "existing install found, moving to $BACKUP"
  mv "$DST" "$BACKUP"
fi

mkdir -p "$DST"

for item in SKILL.md README.md LICENSE CHANGELOG.md references examples tools integrations; do
  [ -e "$SRC/$item" ] && cp -R "$SRC/$item" "$DST/"
done

echo
echo "installed to: $DST"
find "$DST" -type f | sed "s|$DST/|  |" | sort
echo
echo "trigger with: 风光提示词 / 摄影级大片 / 雪山 / 银河 / 极光 / 沙丘 / 屏保长片 / 挑屏保片源 / 画面拆提示词"
