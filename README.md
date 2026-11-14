# Decision Room — How does a smart team make a bad decision?

A team decision tool built for our management presentation. It turns the answer from our slides into a working process:

1. **Share**: everyone answers privately (vote, confidence, what they know that others might not, psychological safety), so nobody is anchored by the boss or the loudest voice.
2. **Challenge**: reveal together, then devil's advocate, pre-mortem, bias alerts, assumptions & risks, weighted criteria and an airtime tracker (Woolley et al., 2010).
3. **Decide**: 8 readiness checks, a tripwire ("what would change our call?"), an action plan with owners and dates, and a report.
4. **Learn**: judge the process and the outcome separately.

Managers get a full manager section. Each teammate joins with a 6-letter room code (or QR) and gets their own section: Inbox, My tasks, Decisions. No accounts needed.

## Deploy on Netlify (about 5 minutes)

The site has a small serverless function (`netlify/functions/api.mjs`) that stores rooms in **Netlify Blobs**. Functions need a real deploy, so use one of these:

**Option A: GitHub (recommended)**
1. Create a new GitHub repository and upload everything in this folder (keep the folder structure).
2. In Netlify: **Add new site → Import an existing project → GitHub** → pick the repository.
3. Build settings are read from `netlify.toml` automatically. Leave them as they are and press **Deploy**.

**Option B: Netlify CLI**
```bash
npm install -g netlify-cli
netlify login
netlify deploy --prod      # run inside this folder
```

> Netlify Drop (drag-and-drop) only publishes static files. The site still opens, but only "Try on this device" mode works, because team rooms need the function.

## Turn on the AI (optional)

1. Get an API key at https://console.anthropic.com
2. Netlify → your site → **Site configuration → Environment variables → Add a variable**
   - Key: `ANTHROPIC_API_KEY`  Value: your key
   - Optional: `AI_MODEL` (default `claude-sonnet-5-5`)
3. Redeploy (Deploys → Trigger deploy).

AI features: devil's advocate, bias scan, hidden assumptions & risks, plan drafting, executive summary, and a "Help me think" coach for teammates. Without a key every button still works with built-in rules. The AI only receives the decision and anonymous answers, never names. Each room is limited to 150 AI calls per day (change `AI_PER_DAY` in `api.mjs`). API usage is billed to your Anthropic account.

## How to use it

1. Open the site → **Create a team room** (you become the manager). You get a room code, an invite link + QR, and a private manager link (keep it secret: it gives full access).
2. Teammates open the invite link or press **Join with a code**, then type their name.
3. **New decision** → pick a template (or the New Coke practice case from our slides) → teammates answer in their Inbox.
4. **Reveal** when most have answered → run the Challenge tools → **Move to Decide** → generate the plan → **Publish**.
5. On the review date, open **Learn** and save the lesson.

For a class demo on one laptop, use **Try on this device**: switch to "Answer as a team member" and pass the laptop around.

## Files

- `public/index.html` — the whole app (no build step, no framework)
- `netlify/functions/api.mjs` — rooms, members, AI endpoint
- `netlify.toml`, `package.json` — Netlify config and the `@netlify/blobs` dependency

## Privacy and security notes

- Room data lives in your own Netlify account (Netlify Blobs).
- Teammates can never read other people's answers; the manager sees answers (without names when a decision is anonymous).
- Manager key and member tokens are stored hashed on the server; anyone with the manager link has full access to that room.

Research: Woolley et al. (2010) *Science* 330:686–688; Edmondson (1999); Klein (2007); Janis (1972); Kahneman & Tversky; Stasser & Titus (1985). New Coke facts: The Coca-Cola Company; Pendergrast (1993).
