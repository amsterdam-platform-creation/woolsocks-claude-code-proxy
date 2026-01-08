# Claude EU Proxy

GDPR-compliant proxy for Claude Code. Routes all traffic through Vertex AI (EU) with PII redaction.

## Features

- 🇪🇺 **EU data residency** - All requests go through Vertex AI `europe-west1` (Belgium)
- 🔒 **PII pseudonymization** - Emails, phones, BSN, IBAN, postcodes automatically redacted
- 🖼️ **Image PII redaction** - Apple Vision OCR detects and redacts PII in images (on-device, free)
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
- **macOS** (for Apple Vision OCR)
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

| Type | Example | Token |
|------|---------|-------|
| Email | john@example.com | `EMAIL_1` |
| Dutch mobile | 06-12345678 | `PHONE_NL_1` |
| Dutch landline | 020-1234567 | `PHONE_NL_2` |
| BSN | 123456789 | `BSN_1` |
| IBAN | NL91ABNA0417164300 | `IBAN_1` |
| Postcode | 1234 AB | `POSTCODE_NL_1` |

**Not redacted:** UUIDs (e.g., `a2fd77a3-db1a-40eb-bf39-2c98cf364a89`) - these are pseudonymous identifiers that are not directly identifying without a lookup database.

## How It Works

```
Claude Code → Local Proxy (localhost:3030) → PII Pseudonymization → Vertex AI (EU)
                     ↓                              ↓
              Image OCR (Apple Vision)    De-pseudonymize responses
              100% on-device, free        before returning to user
```

1. **Request arrives** - Claude Code sends request to proxy
2. **PII detected** - Proxy finds PII and replaces with tokens (`EMAIL_1`, etc.)
3. **Images processed** - Apple Vision OCR finds text, redacts PII regions with black boxes
4. **Forward to EU** - Request sent to Vertex AI in `europe-west1` (Belgium)
5. **Response received** - Claude's response contains tokens, not real PII
6. **De-pseudonymize** - Proxy replaces tokens with original values
7. **Return to user** - You see the response with real data, but Claude never saw it

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
│   ├── index.js      # Express proxy server
│   ├── pii.js        # PII detection and pseudonymization
│   ├── images.js     # Apple Vision OCR and image redaction
│   └── vertex.js     # Vertex AI SDK client
├── bin/
│   └── vision-ocr    # Compiled Swift binary for OCR
├── test/
│   ├── test-pii.js   # PII pattern tests
│   └── test-proxy.js # E2E proxy tests
├── .env              # Configuration
└── package.json
```

## GDPR Compliance

This proxy ensures GDPR compliance by:

1. **Data stays in EU** - Vertex AI `europe-west1` keeps all processing in Belgium
2. **PII never reaches Claude** - Only pseudonymized tokens are sent
3. **Image processing is local** - Apple Vision runs 100% on your Mac
4. **No data persistence** - PII mappings exist only during request lifetime

## License

ISC

## Author

Jochem van Engers (CPO @ Woolsocks)
