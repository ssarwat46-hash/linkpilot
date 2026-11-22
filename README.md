# LinkPilot

Self-hosted LinkedIn prospecting that runs from your own Chrome, slowly and inside safe limits.

- Describe who you want to meet in plain English ("hair transplant clinic owners in Dubai and London").
- The AI turns that into LinkedIn searches, screens the results, and queues only people who fit.
- The Chrome extension sends up to **15 connection requests a day**, ~32 minutes apart, inside an 8-hour window, **without a note** (works on free LinkedIn).
- When someone accepts, it sends **one** AI-written message based on their profile. Nobody is contacted twice.
- AI runs on **your own ChatGPT plan** via [Sign in with ChatGPT](https://developers.openai.com/siwc), or an OpenAI API key if you prefer.

> **Heads up:** automating LinkedIn is against LinkedIn's User Agreement and can get an account restricted. Keep the limits low and use it at your own risk.

```
Dashboard (Firebase Hosting) --/api/**--> Cloud Run API --> Firestore
Chrome extension (your laptop) --/api/ext/*--> same API --> LinkedIn tabs in your Chrome
                                               API --> ChatGPT plan (Responses API)
```

| Folder | What it is |
| --- | --- |
| `extension/` | Chrome extension (MV3). Opens LinkedIn in background tabs: search pages, profiles (Connect), recent connections, and the message box. |
| `server/` | Node/Express API for Cloud Run + Firestore. Owns the queue, the limits, the AI calls and the ChatGPT tokens. |
| `web/` | Dashboard (vanilla JS) on Firebase Hosting. Google sign-in with an email allowlist. |

Every install is its own deployment in your own Google Cloud project. Nothing is shared between users.

## Setup (about 30 min)

You need a Google Cloud / Firebase project with billing on (usage normally sits in the free tier), plus the `gcloud` and `firebase` CLIs.

### 1. Firebase project
1. Create a new Firebase project.
2. **Firestore**: create a database in production mode.
3. **Authentication** > Sign-in method > enable **Google**.
4. **Project settings** > Your apps > add a **Web app**. Copy `web/config.example.js` to `web/config.js` and paste the config in. (`web/config.js` is git-ignored.)

### 2. Extension token
A long random string the extension uses as its password. Keep it out of git.
```bash
openssl rand -hex 24
```

### 3. Deploy the API
```bash
gcloud config set project YOUR_PROJECT_ID
gcloud run deploy linkpilot-api --source server --region us-central1 --allow-unauthenticated --max-instances 1 \
  --set-env-vars "^|^ADMIN_EMAILS=you@gmail.com,teammate@gmail.com|EXT_TOKEN=PASTE_TOKEN|GOOGLE_CLOUD_PROJECT=YOUR_PROJECT_ID"
```
`^|^` makes gcloud split on `|` because the email list has commas. `--max-instances 1` keeps ChatGPT token refreshes in one place.

### 4. Deploy the dashboard, rules and index
```bash
firebase use YOUR_PROJECT_ID
firebase deploy --only hosting,firestore
```
Open `https://YOUR_PROJECT_ID.web.app` and sign in with an allowed email. The Firestore index takes a few minutes to build the first time.

### 5. Connect ChatGPT
Dashboard > **AI account** > **Sign in with ChatGPT**. Approve in the new tab. That tab then shows "127.0.0.1 refused to connect": that's expected. Copy its full address (`http://127.0.0.1:1455/auth/callback?...`), paste it into the dashboard and click **Finish sign-in**. Pick a model. The server keeps the login fresh (access tokens last 1 hour, refresh tokens 30 days and rotate).

No ChatGPT plan? Open "Use an OpenAI API key instead" and paste a key.

### 6. Install the extension
1. Chrome > `chrome://extensions` > **Developer mode** on > **Load unpacked** > pick the `extension` folder.
2. Click the LinkPilot icon, open setup (gear), paste the dashboard URL and the token, then **Save & test**.
3. Stay logged into LinkedIn in that Chrome profile and keep Chrome open.

### 7. Go
1. Write the **campaign prompt**, then click **Preview searches**.
2. Fill in **About you** and the **message rules**, then click **Preview a message**.
3. Press **Start** (dashboard or extension popup). It starts paused.

## How it works
- The extension asks the API for work every 2 minutes. Order: a due connection request, then a follow-up DM, then an accepted-check (every 3 h), then a search page (up to 6 a day, only while fewer than 20 people are queued).
- Requests: 15/day, 90/week, 30-34 min apart, 10:00-18:00 in your timezone. All editable in the dashboard.
- Everyone the AI has ever seen is stored (keyed by profile URL), so nobody is queued or contacted twice. People the AI rejects are kept as `ai_skipped`.
- DMs: one per person, only after they accept, only if the chat is empty. If sending can't be confirmed it's marked `dm_failed` and never retried.
- LinkedIn weekly-limit popup: auto-pause 48 h. Logged out: retry every 30 min. ChatGPT usage limit: AI pauses 1 h.
- Secrets: the ChatGPT tokens and any API key live in Firestore under `private/` (rules deny all client access) and are never returned by the API.

## Limits to know
- Runs only while the laptop is on, Chrome is open and LinkedIn is logged in.
- LinkedIn changes its page layout. If search, connect or messaging starts failing, update the selectors in `extension/linkedin.js`.
- Free LinkedIn accounts have a monthly people-search cap; keep `searchesPerDay` low.
- Sign in with ChatGPT is OpenAI's preview program for open-source and self-hosted apps; availability and limits are set by OpenAI.

## Develop
```bash
cd server && npm install && npm test
```

## License
MIT
