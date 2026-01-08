# Claude EU Proxy - Setup for Teammates

Complete 5-minute setup for GDPR-compliant Claude Code with cost tracking.

## 1️⃣ Clone the Project

```bash
cd ~/projects
git clone https://github.com/jvanengers/claude-eu-proxy.git
cd claude-eu-proxy
```

## 2️⃣ Install Dependencies

```bash
npm install
```

## 3️⃣ Run Setup Script

This automatically creates the statusline and shell alias:

```bash
npm run setup
```

You'll see:
```
✅ Statusline script created at ~/.claude/statusline.sh
✅ Claude Code settings updated at ~/.claude/settings.json
✅ Added 'claude-eu' alias to ~/.zshrc
```

Then reload your shell:

```bash
source ~/.zshrc
# or ~/.bashrc if you use bash
```

## 4️⃣ Configure Google Cloud (One Time)

Authenticate with Google Cloud:

```bash
gcloud auth application-default login
```

This opens a browser. Sign in with your Google account.

Create `.env` file:

```bash
cp .env.example .env
```

Edit `.env` and set your GCP project ID:

```
GCP_PROJECT_ID=woolsocks-marketing-ai
VERTEX_REGION=europe-west1
PORT=3030
```

## 5️⃣ Start the Proxy

```bash
npm start
```

You'll see:
```
🇪🇺 Claude EU Proxy listening on port 3030
✅ Vertex AI EU (europe-west1) connected
```

**Keep this running in the background** while you use Claude Code.

## 6️⃣ Use Claude Code

In **another terminal**, just type:

```bash
claude-eu
```

Or use it with a prompt:

```bash
claude-eu "What is Claude Code?"
```

Your statusline will show:
```
✅ 🇪🇺 EU | 🟢 Haiku | 💰 $0.34 | 📅 $12.45 Jan | 🟡 67% ctx
```

---

## What the Setup Does

- **Statusline Script** (~/.claude/statusline.sh) - Shows real-time costs, model, and context usage
- **Claude Settings** (~/.claude/settings.json) - Connects Claude Code to the statusline
- **Shell Alias** (claude-eu) - Automatically starts proxy & routes traffic to EU servers

## That's it! 🚀

Every time you use `claude-eu`:
1. ✅ All traffic goes through EU servers (Vertex AI Belgium)
2. ✅ PII is automatically redacted before Claude sees it
3. ✅ Your statusline shows real-time costs
4. ✅ Works exactly like normal Claude Code

## Questions?

Ask Jochem (@jochem) in Slack.
