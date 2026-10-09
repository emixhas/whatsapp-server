#!/usr/bin/env bash
# Claude Code komutunun tam yolunu bulur ve yazdırır; bulamazsa çıkış kodu 1.
# Arka plan servisi (launchd) kullanıcının kabuk ayarlarını (nvm, npm, yerel kurulum) yüklemez;
# bu yüzden bilinen kurulum yerleri ve kullanıcının kendi giriş kabuğu sırayla denenir.
#   bash scripts/find_claude.sh        → /Users/<ad>/.local/bin/claude
# Elle sabitlemek için secrets/.env içine CLAUDE_BIN=/tam/yol/claude yazılabilir.
ok() { [ -n "$1" ] && [ -x "$1" ] && [ ! -d "$1" ] && { echo "$1"; exit 0; }; }
ok "$CLAUDE_BIN"
ENVF="$(cd "$(dirname "$0")/.." && pwd)/secrets/.env"
[ -f "$ENVF" ] && ok "$(sed -n 's/^CLAUDE_BIN=//p' "$ENVF" | tail -1 | tr -d '"'"'"' ')"
ok "$(command -v claude 2>/dev/null)"
for p in "$HOME/.claude/local/claude" "$HOME/.local/bin/claude" "/opt/homebrew/bin/claude" "/usr/local/bin/claude" \
         "$HOME/.npm-global/bin/claude" "$HOME/.bun/bin/claude" "$HOME/.volta/bin/claude" "$HOME/Library/pnpm/claude" \
         $(ls -d "$HOME"/.nvm/versions/node/*/bin/claude 2>/dev/null | sort -r) \
         $(ls -d "$HOME"/.fnm/node-versions/*/installation/bin/claude 2>/dev/null | sort -r); do
  ok "$p"
done
# Son çare: kullanıcının kendi kabuğunu (zsh/bash) etkileşimli giriş kabuğu olarak açıp sor
for sh in "$SHELL" /bin/zsh /bin/bash; do
  [ -x "$sh" ] || continue
  p=$(timeout 15 "$sh" -lic 'command -v claude' 2>/dev/null </dev/null | tail -1) 2>/dev/null \
    || p=$("$sh" -lic 'command -v claude' 2>/dev/null </dev/null | tail -1)
  ok "$p"
done
exit 1
