#!/bin/bash
# Setup script for Claude EU Proxy statusline + shell alias
# Run this after: npm install

set -e

echo "🚀 Setting up Claude EU Proxy statusline..."

# Create ~/.claude directory
mkdir -p ~/.claude

# Create statusline script
cat > ~/.claude/statusline.sh << 'EOF'
#!/bin/bash
# Claude Code Status Line - Shows proxy health + session routing + real-time Vertex AI costs

COSTS=$(curl -s http://localhost:3030/costs 2>/dev/null)
PROXY_RUNNING=false

if [ -n "$COSTS" ] && [ "$COSTS" != "" ]; then
    PROXY_RUNNING=true
fi

if [ "$ANTHROPIC_BASE_URL" = "http://localhost:3030" ]; then
    SESSION_STATUS="🇪🇺 EU"
else
    SESSION_STATUS="🇺🇸 US"
fi

if [ "$PROXY_RUNNING" = true ]; then
    PROXY_HEALTH="✅"
else
    PROXY_HEALTH="⚠️"
fi

input=$(cat)
MODEL=$(echo "$input" | jq -r '.model.display_name // "claude"' 2>/dev/null)

if [ "$PROXY_RUNNING" = false ]; then
    echo "${PROXY_HEALTH} Proxy ${SESSION_STATUS} | ${MODEL}"
    exit 0
fi

if [ "$SESSION_STATUS" != "🇪🇺 EU" ]; then
    echo "${PROXY_HEALTH} ${SESSION_STATUS} | ${MODEL}"
    exit 0
fi

COST=$(echo "$COSTS" | jq -r '.formattedCost // "$0.0000"')
MONTHLY_COST=$(echo "$COSTS" | jq -r '.monthly.formattedCost // "$0.00"')
MONTH=$(echo "$COSTS" | jq -r '.monthly.month // "Month"')

CONTEXT_SIZE=$(echo "$input" | jq -r '.context_window.context_window_size // 200000' 2>/dev/null)
INPUT_TOKENS=$(echo "$input" | jq -r '.context_window.current_usage.input_tokens // 0' 2>/dev/null)
CACHE_READ=$(echo "$input" | jq -r '.context_window.current_usage.cache_read_input_tokens // 0' 2>/dev/null)

MODEL_NAME=$(echo "$COSTS" | jq -r '.byModel | keys[0] // empty' 2>/dev/null)
if [ -z "$MODEL_NAME" ]; then
  MODEL_NAME=$(echo "$input" | jq -r '.model.name // "unknown"' 2>/dev/null)
fi

case "$MODEL_NAME" in
  *opus*|*Opus*)
    MODEL="🔴 OPUS"
    ;;
  *sonnet*|*Sonnet*)
    MODEL="🟡 Sonnet"
    ;;
  *haiku*|*Haiku*)
    MODEL="🟢 Haiku"
    ;;
  *)
    MODEL="$MODEL_NAME"
    ;;
esac

TOTAL_TOKENS=$((INPUT_TOKENS + CACHE_READ))
if [ "$CONTEXT_SIZE" -gt 0 ] 2>/dev/null; then
    PERCENT=$((TOTAL_TOKENS * 100 / CONTEXT_SIZE))
else
    PERCENT=0
fi

if [ "$PERCENT" -lt 50 ]; then
    CTX="🟢 ${PERCENT}%"
elif [ "$PERCENT" -lt 80 ]; then
    CTX="🟡 ${PERCENT}%"
else
    CTX="🔴 ${PERCENT}%"
fi

echo "${PROXY_HEALTH} ${SESSION_STATUS} | ${MODEL} | 💰 ${COST} | 📅 ${MONTHLY_COST} ${MONTH} | ${CTX} ctx"
EOF

chmod +x ~/.claude/statusline.sh
echo "✅ Statusline script created at ~/.claude/statusline.sh"

# Create Claude Code settings
cat > ~/.claude/settings.json << 'EOF'
{
  "model": "haiku",
  "statusLine": {
    "type": "command",
    "command": "~/.claude/statusline.sh"
  }
}
EOF

echo "✅ Claude Code settings updated at ~/.claude/settings.json"

# Get the directory where this script is located
PROXY_PATH="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Detect shell
if [ -n "$ZSH_VERSION" ]; then
    SHELL_RC="$HOME/.zshrc"
elif [ -n "$BASH_VERSION" ]; then
    SHELL_RC="$HOME/.bashrc"
else
    echo "⚠️  Could not detect shell. Please add the alias manually."
    SHELL_RC=""
fi

# Add shell alias if shell was detected
if [ -n "$SHELL_RC" ]; then
    # Check if alias already exists
    if ! grep -q "claude-eu()" "$SHELL_RC"; then
        cat >> "$SHELL_RC" << 'EOF'

# Claude EU - GDPR-compliant Claude Code with cost tracking
claude-eu() {
  if ! lsof -i :3030 >/dev/null 2>&1; then
    echo "🇪🇺 Starting Claude EU Proxy..."
    node /Users/jochem/projects/claude-eu-proxy/src/index.js >/dev/null 2>&1 &
    sleep 1
    if ! lsof -i :3030 >/dev/null 2>&1; then
      echo "❌ Failed to start proxy"
      return 1
    fi
    echo "✅ Proxy ready"
  fi
  ANTHROPIC_BASE_URL=http://localhost:3030 claude "$@"
}
EOF
        echo "✅ Added 'claude-eu' alias to $SHELL_RC"
    else
        echo "ℹ️  'claude-eu' alias already exists in $SHELL_RC"
    fi
fi

echo ""
echo "════════════════════════════════════════════════════════"
echo "🎉 Setup complete!"
echo "════════════════════════════════════════════════════════"
echo ""
echo "Next steps:"
echo "1. Reload your shell:"
if [ -n "$SHELL_RC" ]; then
    echo "   source $SHELL_RC"
fi
echo ""
echo "2. Configure Google Cloud (one time):"
echo "   gcloud auth application-default login"
echo ""
echo "3. Create .env in the proxy directory:"
echo "   cp .env.example .env"
echo "   # Edit .env and set GCP_PROJECT_ID"
echo ""
echo "4. Start the proxy:"
echo "   npm start"
echo ""
echo "5. In another terminal, use Claude with:"
echo "   claude-eu"
echo ""
echo "Your statusline will show:"
echo "   ✅ 🇪🇺 EU | 🟢 Haiku | 💰 \$0.34 | 📅 \$12.45 Jan | 🟡 67% ctx"
echo ""
