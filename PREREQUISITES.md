# Prerequisites for Claude EU Proxy

## System Requirements

- **Node.js 20+** (`node --version`)
- **Google Cloud SDK** (gcloud CLI)
- **jq** (for JSON parsing in statusline)
- **curl** (for statusline health checks)
- **lsof** (for port checking in shell alias)

### Check What You Have

```bash
node --version       # Should be v20.0.0+
gcloud --version     # Should be installed
which jq             # If not found: brew install jq (macOS) or apt install jq (Linux)
which curl           # Usually pre-installed
which lsof           # Usually pre-installed
```

---

## Google Cloud Setup

### 1. Google Account

You need a Google account (personal or workspace). This can be:
- Your personal Google account
- Your company Google Workspace account
- Your Google Cloud organization account

### 2. GCP Project

You need a **Google Cloud Project** with Vertex AI enabled.

**Option A: Use existing project**
```bash
# List your projects
gcloud projects list

# Set default project
gcloud config set project YOUR_PROJECT_ID
```

**Option B: Create a new project**
```bash
gcloud projects create claude-eu-proxy --set-as-default
gcloud projects describe claude-eu-proxy --format='value(projectNumber)'
```

### 3. Enable Vertex AI API

```bash
gcloud services enable aiplatform.googleapis.com \
  --project=YOUR_PROJECT_ID
```

### 4. Enable Claude in Vertex AI Model Garden

1. Go to: https://console.cloud.google.com/vertex-ai/model-garden
2. Search for "Claude"
3. Select a Claude model (e.g., **Claude Opus 4.5**)
4. Click **Enable**
5. Accept the terms
6. Select region: **`europe-west1`** (Belgium - for EU compliance)

> **Note:** You must enable at least one Claude model. All models in the same region are available once one is enabled.

### 5. IAM Role: "Vertex AI User"

Your Google account needs the `roles/aiplatform.user` role on the project.

**Check if you have it:**
```bash
gcloud projects get-iam-policy YOUR_PROJECT_ID \
  --flatten="bindings[].members" \
  --filter="bindings.members:user:YOUR_EMAIL@example.com"
```

**If you don't have it, ask your GCP admin:**
```bash
gcloud projects add-iam-policy-binding YOUR_PROJECT_ID \
  --member="user:YOUR_EMAIL@example.com" \
  --role="roles/aiplatform.user"
```

### 6. Authentication

Choose one method:

#### Option A: User Credentials (Recommended for development)

```bash
gcloud auth application-default login
```

This opens a browser and authenticates your Google account.

#### Option B: Service Account (Recommended for production/CI)

Ask your GCP admin to:
1. Create a service account with name `claude-proxy`
2. Grant it `roles/aiplatform.user` role
3. Create a key (JSON format)
4. Share the key file with you

Then set the environment variable:
```bash
export GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account-key.json
```

---

## Billing

Vertex AI pricing is **per-region**. `europe-west1` (Belgium) has a **10% premium** over US pricing.

**Example monthly costs** (with heavy daily use):
- Haiku: ~$20-50/month
- Sonnet: ~$50-150/month
- Opus: ~$150-300+/month

You need an **active Google Cloud billing account** to use Vertex AI.

**Check if billing is enabled:**
```bash
gcloud billing accounts list
gcloud billing projects describe YOUR_PROJECT_ID
```

If billing is not enabled, you'll get an error when trying to use Claude.

---

## Summary Checklist

- [ ] Node.js 20+
- [ ] gcloud CLI installed
- [ ] jq installed
- [ ] Google account
- [ ] GCP project with billing enabled
- [ ] Vertex AI API enabled
- [ ] Claude model enabled in Model Garden (europe-west1 region)
- [ ] "Vertex AI User" role assigned to your account
- [ ] Authenticated with `gcloud auth application-default login`

---

## Common Errors & Fixes

### "Permission denied" when starting proxy

**Cause:** Missing `roles/aiplatform.user` role or not authenticated.

**Fix:**
```bash
gcloud auth application-default login
gcloud projects add-iam-policy-binding YOUR_PROJECT_ID \
  --member="user:YOUR_EMAIL@example.com" \
  --role="roles/aiplatform.user"
```

---

### "Model not found" or "Model is not available"

**Cause:** Claude model not enabled in Model Garden for your region.

**Fix:**
1. Go to https://console.cloud.google.com/vertex-ai/model-garden
2. Search "Claude"
3. Enable the model for `europe-west1`

---

### "Billing account not found"

**Cause:** No active billing account on your GCP project.

**Fix:**
1. Go to https://console.cloud.google.com/billing
2. Create a billing account (requires credit card)
3. Link it to your project

---

### "jq: command not found" in statusline

**Cause:** jq not installed.

**Fix:**
```bash
# macOS
brew install jq

# Linux
sudo apt-get install jq
```

---

## Questions?

Ask Jochem (@jochem) in Slack if you're unsure about any prerequisites.
