# Claude EU Proxy

GDPR-compliant proxy for Claude Code. Routes all traffic through Vertex AI (EU) with PII redaction.

## Features

- 🇪🇺 **EU data residency** - All requests go through Vertex AI `europe-west1` (Belgium)
- 🔒 **PII pseudonymization** - Emails, phones, BSN, IBAN, postcodes automatically redacted
- 💰 **Rate limiting** - Per-tool invocation limits to control API costs
- ⚡ **Streaming support** - Full support for streaming responses
- 🔄 **Transparent** - Works exactly like the regular Claude Code, just safer

## Quick Start

### Option 1: One-Command Setup (Recommended)

Add this function to your `~/.zshrc` or `~/.bashrc`:

```bash
# Claude EU - GDPR-compliant Claude Code (all traffic through Vertex AI Belgium)
claude-eu() {
  # Check if proxy is already running on port 3030
  if ! lsof -i :3030 >/dev/null 2>&1; then
    echo "🇪🇺 Starting Claude EU Proxy..."
    node /path/to/claude-eu-proxy/src/index.js >/dev/null 2>&1 &
    sleep 1
    # Verify it started
    if ! lsof -i :3030 >/dev/null 2>&1; then
      echo "❌ Failed to start proxy"
      return 1
    fi
    echo "✅ Proxy running on localhost:3030"
  fi
  ANTHROPIC_BASE_URL=http://localhost:3030 claude "$@"
}
```

> **Note:** Replace `/path/to/claude-eu-proxy` with your actual install path.

Then reload your shell:
```bash
source ~/.zshrc
```

Now just use:
```bash
claude-eu              # Interactive mode
claude-eu "prompt"     # One-off prompt
claude-eu --print "?"  # With flags
```

The function automatically:
- ✅ Starts the proxy if not running
- ✅ Reuses existing proxy if already running
- ✅ Passes all arguments to Claude Code

### Option 2: Manual Start

1. **Start the proxy:**
   ```bash
   npm start
   ```

2. **Use Claude Code (in another terminal):**
   ```bash
   ANTHROPIC_BASE_URL=http://localhost:3030 claude "your prompt"
   ```

## Requirements

- **Node.js 20+**
- **Google Cloud** - see permissions below

### Google Cloud Setup

#### 1. Enable Vertex AI API

```bash
gcloud services enable aiplatform.googleapis.com --project=YOUR_PROJECT_ID
```

#### 2. Enable Claude in Model Garden

1. Go to [Vertex AI Model Garden](https://console.cloud.google.com/vertex-ai/model-garden)
2. Search for "Claude"
3. Select the model (e.g., Claude Sonnet 4)
4. Click **Enable** and accept terms
5. Select region: `europe-west1` (Belgium)

#### 3. Authentication (choose one)

**Option A: User credentials (for local development)**
```bash
gcloud auth application-default login
```

Your user account needs the `Vertex AI User` role:
```bash
gcloud projects add-iam-policy-binding YOUR_PROJECT_ID \
  --member="user:your-email@example.com" \
  --role="roles/aiplatform.user"
```

**Option B: Service account (for production/CI)**
```bash
# Create service account
gcloud iam service-accounts create claude-proxy \
  --display-name="Claude EU Proxy" \
  --project=YOUR_PROJECT_ID

# Grant Vertex AI access
gcloud projects add-iam-policy-binding YOUR_PROJECT_ID \
  --member="serviceAccount:claude-proxy@YOUR_PROJECT_ID.iam.gserviceaccount.com" \
  --role="roles/aiplatform.user"

# Create and download key
gcloud iam service-accounts keys create key.json \
  --iam-account=claude-proxy@YOUR_PROJECT_ID.iam.gserviceaccount.com

# Set environment variable
export GOOGLE_APPLICATION_CREDENTIALS=/path/to/key.json
```

#### Required IAM Role

| Role | Purpose |
|------|---------|
| `roles/aiplatform.user` | Call Vertex AI models (including Claude) |

> **Note:** This is the minimum required role. It allows calling models but not managing infrastructure.

## Configuration

Edit `.env` to customize:

```bash
PORT=3030                              # Proxy port
GCP_PROJECT_ID=woolsocks-marketing-ai  # Your GCP project
VERTEX_REGION=europe-west1             # EU region for Claude
```

## PII Patterns Detected

Supports all Woolsocks markets (NL, DE, BE, FR, IT, ES, IE) plus UK.

### Universal Patterns

| Type | Example | Token |
|------|---------|-------|
| Email | john@example.com | `EMAIL_1` |
| IBAN | NL91ABNA0417164300 | `IBAN_1` |

### Phone Numbers (by country)

| Country | Type | Example | Token |
|---------|------|---------|-------|
| NL | Mobile/Landline | 06-12345678, +31 6 1234 5678 | `PHONE_NL_1` |
| DE | Mobile/Landline | +49 170 1234567 | `PHONE_DE_1` |
| FR | Mobile/Landline | +33 6 12 34 56 78 | `PHONE_FR_1` |
| BE | Mobile/Landline | +32 470 12 34 56 | `PHONE_BE_1` |
| IT | Mobile | +39 333 1234567 | `PHONE_IT_1` |
| ES | Mobile | +34 612 345 678 | `PHONE_ES_1` |
| IE | Mobile | +353 87 123 4567 | `PHONE_IE_1` |
| UK | Mobile | +44 7911 123456 | `PHONE_UK_1` |

### National IDs (by country)

| Country | Type | Example | Token |
|---------|------|---------|-------|
| NL | BSN | 123456789, 123.456.789 | `BSN_1` |
| DE | Steuer-ID | 12345678901 | `STEUER_ID_1` |
| FR | NIR (INSEE) | 1 85 01 75 123 456 78 | `NIR_1` |
| BE | Rijksregisternummer | 85.01.01-123.45 | `RRN_1` |
| IT | Codice Fiscale | RSSMRA85A01H501Z | `CODICE_FISCALE_1` |
| ES | NIF | 12345678Z | `NIF_1` |
| ES | NIE | X1234567L | `NIE_1` |
| IE | PPS Number | 1234567FA | `PPS_1` |
| UK | NIN | AB123456C | `UK_NIN_1` |

### Postcodes (by country)

| Country | Format | Example | Token |
|---------|--------|---------|-------|
| NL | 4 digits + 2 letters | 1234 AB | `POSTCODE_NL_1` |
| UK | Alphanumeric | SW1A 1AA | `POSTCODE_UK_1` |
| IE | Eircode | D02 AF30 | `POSTCODE_IE_1` |

> **Note:** DE/FR/IT/ES/BE use 4-5 digit postcodes which have high false positive risk (match years, prices). We detect their more specific national IDs instead.

### Not Redacted

- **UUIDs** (e.g., `a2fd77a3-db1a-40eb-bf39-2c98cf364a89`) - these are pseudonymous identifiers that are not directly identifying without a lookup database
- **Names** - Too many false positives; rely on other PII removal

## How It Works

```
Claude Code → Local Proxy (localhost:3030) → PII Pseudonymization → Vertex AI (EU)
                                                    ↓
                                          De-pseudonymize responses
                                          before returning to user
```

1. **Request arrives** - Claude Code sends request to proxy
2. **PII detected** - Proxy finds PII and replaces with tokens (`EMAIL_1`, etc.)
3. **Forward to EU** - Request sent to Vertex AI in `europe-west1` (Belgium)
4. **Response received** - Claude's response contains tokens, not real PII
5. **De-pseudonymize** - Proxy replaces tokens with original values
6. **Return to user** - You see the response with real data, but Claude never saw it

## Cost Tracking

The proxy tracks Vertex AI costs in real-time, both per-session and per-month.

**Check current costs:**
```bash
curl http://localhost:3030/costs
```

Response:
```json
{
  "formattedCost": "$0.4521",
  "requests": 12,
  "session": {
    "durationMinutes": 45.2,
    "costPerMinute": 0.01
  },
  "monthly": {
    "month": "Jan",
    "formattedCost": "$23.45",
    "requests": 156
  }
}
```

**Pricing:** Uses Vertex AI `europe-west1` rates (10% regional premium).

| Model | Input/1M | Output/1M |
|-------|----------|-----------|
| Opus 4.5 | $5.50 | $27.50 |
| Sonnet 4 | $3.30 | $16.50 |
| Haiku 3.5 | $1.10 | $5.50 |

**Statusline integration:** See the [Statusline Setup](#statusline-setup) section for displaying costs in Claude Code.

## Statusline Setup

Display real-time costs in your Claude Code statusline:

1. **Create statusline script** at `~/.claude/statusline.sh`:
   ```bash
   #!/bin/bash
   COSTS=$(curl -s http://localhost:3030/costs 2>/dev/null)
   if [ -z "$COSTS" ]; then
     echo "🔌 Proxy offline"
     exit 0
   fi

   COST=$(echo "$COSTS" | jq -r '.formattedCost')
   MONTHLY=$(echo "$COSTS" | jq -r '.monthly.formattedCost')
   MONTH=$(echo "$COSTS" | jq -r '.monthly.month')

   echo "💰 ${COST} | 📅 ${MONTHLY} ${MONTH}"
   ```

2. **Make executable:**
   ```bash
   chmod +x ~/.claude/statusline.sh
   ```

3. **Configure Claude Code** in `~/.claude/settings.json`:
   ```json
   {
     "statusLine": {
       "type": "command",
       "command": "~/.claude/statusline.sh"
     }
   }
   ```

4. **Restart Claude Code** to see costs in your statusline.

## Rate Limiting

The proxy limits how many times each MCP tool can be invoked per session (proxy lifetime) to control API costs.

| Tool | Limit | Notes |
|------|-------|-------|
| `zendesk` | 50 calls | Customer data |
| `jira` | 100 calls | Higher volume, less sensitive |
| `slack-messaging` | 50 calls | Conversation batches |
| `sentry` | 30 calls | Error batches |
| Default | 50 calls | All other tools |

**When a limit is reached:**
- Proxy returns a 429 error with a clear message
- Restart the proxy to reset all limits

**Check current usage:**
```bash
curl http://localhost:3030/stats
# {"toolUsage":{"zendesk":5,"jira":12}}
```

## Testing

```bash
npm test          # Run PII pattern tests
npm run test:pii  # PII tests only
npm run test:proxy # End-to-end proxy test (requires proxy running)
```

## Architecture

```
claude-eu-proxy/
├── src/
│   ├── index.js        # Express proxy server
│   ├── pii.js          # PII detection and pseudonymization
│   ├── cost-tracker.js # Cost tracking with persistent monthly storage
│   ├── rate-limiter.js # Per-tool rate limiting
│   └── vertex.js       # Vertex AI SDK client
├── test/
│   ├── test-pii.js     # PII pattern tests
│   └── test-proxy.js   # E2E proxy tests
├── costs-history.json  # Persistent cost data (gitignored)
├── .env                # Configuration
└── package.json
```

## GDPR Compliance

This proxy ensures GDPR compliance by:

1. **Data stays in EU** - Vertex AI `europe-west1` keeps all processing in Belgium
2. **PII never reaches Claude** - Only pseudonymized tokens are sent
3. **No data persistence** - PII mappings exist only during request lifetime

## License

ISC

## Author

Jochem van Engers (CPO @ Woolsocks)
