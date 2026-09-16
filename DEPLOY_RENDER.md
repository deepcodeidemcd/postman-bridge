# Deploy to Render.com — Step by Step

## Prerequisites
1. GitHub account (to push code)
2. Render account (free tier available)
3. Your Postman session files (`.sessions/` folder)

## Step 1: Push to GitHub
```bash
cd D:\hoat_hinh\postman-openai-bridge-v0.1.0
git init
git add -A
git commit -m "deploy to render"
git remote add origin https://github.com/YOUR_USERNAME/postman-bridge.git
git push -u origin main
```

## Step 2: Create Render Service
1. Go to https://dashboard.render.com
2. Click "New +" → "Web Service"
3. Connect your GitHub repo
4. Settings:
   - **Name**: postman-bridge
   - **Runtime**: Docker
   - **Plan**: Starter ($10/month, 2GB RAM) — free tier is too small
   - **Port**: 10000

## Step 3: Set Environment Variables
In Render dashboard → Environment tab, add:

| Key | Value |
|---|---|
| `POSTMAN_WORKSPACE_URL` | Your Postman workspace URL |
| `BRIDGE_API_KEY` | `{"default":"sk-your-secret-key"}` |
| `POSTMAN_HEADLESS` | `true` |
| `NODE_ENV` | `production` |

## Step 4: Upload Session Files
Render's filesystem is ephemeral (sessions lost on restart). Options:

**Option A: Bake sessions into Docker image**
- Copy `.sessions/` folder into the repo before pushing
- Sessions persist until next deploy

**Option B: Use Render Disk ($0.20/GB/month)**
- Add a persistent disk in Render dashboard
- Mount at `/app/.sessions`
- Sessions survive restarts

**Option C: External storage (S3, Google Drive)**
- Store sessions externally
- Download on startup

## Step 5: Deploy
Render auto-deploys on push. First deploy takes ~5-10 minutes (building Docker image).

## Step 6: Test
```bash
curl https://your-app.onrender.com/v1/models \
  -H "Authorization: Bearer sk-your-secret-key"
```

## Step 7: Update Client
Point your coding agent to:
```
API_BASE_URL=https://your-app.onrender.com/v1
API_KEY=sk-your-secret-key
```

## Cost Estimate
| Item | Cost |
|---|---|
| Render Starter plan | $10/month |
| Persistent disk (1GB) | $0.20/month |
| **Total** | **~$10.20/month** |

## Important Notes
- **RAM**: The bridge needs ~1GB minimum. Starter plan (2GB) is recommended.
- **Cold starts**: Render sleeps after 15min idle. First request after sleep takes ~30s.
- **Sessions**: Without persistent disk, sessions are lost on restart. Re-run `warm_sessions.py` after each deploy.
- **Rate limits**: Postman rate limits are per-IP. Render's IP is shared with other users.
