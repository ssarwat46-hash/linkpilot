# LinkPilot

Self-hosted LinkedIn prospecting that runs from your own Chrome, slowly and inside safe limits.

- Describe who you want to meet in plain English ("hair transplant clinic owners in Dubai and London").
- The AI turns that into LinkedIn searches, screens the results, and queues only people who fit.
- Each browser running the extension sends up to **15 connection requests a day**, ~32 minutes apart, inside an 8-hour window, **without a note** (works on free LinkedIn). Run it in several browsers (one LinkedIn account each) and each gets its own 15.
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
| `web/` | Dashboard (vanilla JS) on Firebase Hosting. Username/password sign-in. |

Every install is its own deployment in your own Google Cloud project. Nothing is shared between users.

## Setup (about 30 min)

You need a Google Cloud / Firebase project with billing on (usage normally sits in the free tier), plus the `gcloud` and `firebase` CLIs.

### 1. Firebase project
1. Create a new Firebase project.
2. **Firestore**: create a database in production mode.

### 2. Users and session secret
Make a password hash for each dashboard user (the password is typed, not echoed, and never stored):
```bash
cd server && npm install && node tools/hash-password.js
```
and a session secret:
```bash
openssl rand -hex 32
```

### 3. Deploy the API
```bash
gcloud config set project YOUR_PROJECT_ID
gcloud run deploy linkpilot-api --source server --region us-central1 --allow-unauthenticated --max-instances 1 \
  --set-env-vars '^|^LINKPILOT_USERS=alice:scrypt$...;bob:scrypt$...|SESSION_SECRET=PASTE_SECRET|GOOGLE_CLOUD_PROJECT=YOUR_PROJECT_ID'
```
Use single quotes (the hashes contain `$`). `--max-instances 1` keeps ChatGPT token refreshes and the login rate limiter in one place. Changing a user's password (new hash) signs out that user's dashboard sessions.

### 4. Deploy the dashboard, rules and index
```bash
firebase use YOUR_PROJECT_ID
firebase deploy --only hosting,firestore
```
Open `https://YOUR_PROJECT_ID.web.app` and sign in with a username and password from step 2. The Firestore index takes a few minutes to build the first time.

### 5. Connect ChatGPT
Dashboard > **AI account** > **Sign in with ChatGPT**. Approve in the new tab. That tab then shows "127.0.0.1 refused to connect": that's expected. Copy its full address (`http://127.0.0.1:1455/auth/callback?...`), paste it into the dashboard and click **Finish sign-in**. Pick a model. The server keeps the login fresh (access tokens last 1 hour, refresh tokens 30 days and rotate).

No ChatGPT plan? Open "Use an OpenAI API key instead" and paste a key.

### 6. Install the extension
1. Copy `extension/config.example.js` to `extension/config.js` and put your dashboard address in it (then you can zip the folder and hand it out).
2. Chrome > `chrome://extensions` > **Developer mode** on > **Load unpacked** > pick the `extension` folder.
3. Click the LinkPilot icon, log in with a dashboard username and password, and give the browser a name. Only a per-browser key is kept, never the password. Sign a browser out from the dashboard's **Browsers** list.
4. Stay logged into LinkedIn in that Chrome profile and keep Chrome open. Use a different LinkedIn account in each browser.

### 7. Go
1. Write the **campaign prompt**, then click **Preview searches**.
2. Fill in **About you** and the **message rules**, then click **Preview a message**.
3. Press **Start** (dashboard or extension popup). It starts paused.

## How it works
- Each browser has its own limits, counters, gaps and pauses. The campaign, the queue and the AI are shared. A person is pinned to the browser that invited them, so the follow-up DM comes from the same LinkedIn account.
- The extension asks the API for work every 2 minutes. Order: a due connection request, then a follow-up DM, then an accepted-check (every 3 h), then a search page (up to 6 a day, only while fewer than 20 people are queued).
- Requests: 15/day and 90/week per browser, 30-34 min apart, 10:00-18:00 in your timezone. All editable in the dashboard.
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
