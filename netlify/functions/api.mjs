// Decision Room API — one Netlify Function, data in Netlify Blobs.
// Routes (all under /api):
//   GET  /api/health                         -> { ok, ai }
//   POST /api/rooms   {name, team}           -> { code, key, mid, tok }   (creates a room + the manager's member record)
//   GET  /api/room?code&key                  -> manager view: room + all members
//   GET  /api/room?code&mid&tok              -> member view: room without private notes + own record
//   PUT  /api/room?code&key  {decisions,notes,name,team}
//   POST /api/join    {code, name}           -> { mid, tok, name, team }
//   PUT  /api/member?code&mid&tok {d, done}
//   DELETE /api/member?code&key&mid          -> manager removes a teammate
//   POST /api/ai      {code, key | mid+tok, task, payload}  (needs ANTHROPIC_API_KEY, else 501)
import { getStore } from "@netlify/blobs";

const CODE_ABC = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const TOK_ABC = "abcdefghijklmnopqrstuvwxyz0123456789";
const MAX_BODY = 900_000;
const MAX_MEMBERS = 80;
const AI_PER_DAY = 150;

const json = (o, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const rnd = (n, abc) => [...crypto.getRandomValues(new Uint8Array(n))].map((x) => abc[x % abc.length]).join("");
const sha = async (s) => {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(s)));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
};
const clean = (s, n) => String(s ?? "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, n);
const isObj = (o) => o && typeof o === "object" && !Array.isArray(o);

async function body(req) {
  const t = await req.text();
  if (t.length > MAX_BODY) throw Object.assign(new Error("too large"), { status: 413 });
  try { return t ? JSON.parse(t) : {}; } catch { throw Object.assign(new Error("bad json"), { status: 400 }); }
}

export default async (req) => {
  const store = getStore({ name: "decision-room", consistency: "strong" });
  const url = new URL(req.url);
  const route = url.pathname.replace(/^\/(\.netlify\/functions\/)?api\/?/, "").replace(/\/$/, "");
  const q = (k) => url.searchParams.get(k) || "";
  const roomKey = (c) => `rooms/${c}`;
  const memKey = (c, m) => `members/${c}/${m}`;
  const getRoom = async (c) => (/^[A-Z0-9]{6}$/.test(c) ? await store.get(roomKey(c), { type: "json" }) : null);
  const getMember = async (c, m) => (/^[a-z0-9_]{4,24}$/.test(m) ? await store.get(memKey(c, m), { type: "json" }) : null);
  const listMembers = async (c) => {
    const { blobs } = await store.list({ prefix: `members/${c}/` });
    const out = await Promise.all(blobs.map((b) => store.get(b.key, { type: "json" })));
    return out.filter(Boolean);
  };
  const pubMember = (m) => ({ mid: m.mid, name: m.name, joined: m.joined, role: m.role || "member", d: m.d || {}, done: m.done || {} });
  async function authManager(c, key) {
    const room = await getRoom(c);
    if (!room || !key || (await sha(key)) !== room.keyHash) return null;
    return room;
  }
  async function authMember(c, mid, tok) {
    const room = await getRoom(c);
    if (!room) return null;
    const m = await getMember(c, mid);
    if (!m || !tok || (await sha(tok)) !== m.tokHash) return null;
    return { room, m };
  }

  try {
    if (route === "health") return json({ ok: true, ai: !!process.env.ANTHROPIC_API_KEY });

    if (route === "rooms" && req.method === "POST") {
      const b = await body(req);
      const name = clean(b.name, 40) || "Manager";
      const team = clean(b.team, 60) || "Our team";
      let code = "";
      for (let i = 0; i < 6; i++) { code = rnd(6, CODE_ABC); if (!(await store.get(roomKey(code)))) break; }
      const key = rnd(28, TOK_ABC), tok = rnd(24, TOK_ABC), mid = "m_" + rnd(10, TOK_ABC);
      await store.setJSON(roomKey(code), { code, team, keyHash: await sha(key), created: Date.now(), v: 1, decisions: {}, notes: {}, managerMid: mid });
      await store.setJSON(memKey(code, mid), { mid, name, role: "manager", joined: Date.now(), tokHash: await sha(tok), d: {}, done: {} });
      return json({ code, key, mid, tok, team, name });
    }

    if (route === "room" && req.method === "GET") {
      const c = q("code").toUpperCase();
      if (q("key")) {
        const room = await authManager(c, q("key"));
        if (!room) return json({ error: "Room not found or wrong manager key" }, 403);
        const members = (await listMembers(c)).map(pubMember);
        return json({ role: "manager", ai: !!process.env.ANTHROPIC_API_KEY, room: { code: c, team: room.team, v: room.v, decisions: room.decisions || {}, notes: room.notes || {}, managerMid: room.managerMid }, members });
      }
      const a = await authMember(c, q("mid"), q("tok"));
      if (!a) return json({ error: "Not a member of this room" }, 403);
      return json({ role: a.m.role || "member", ai: !!process.env.ANTHROPIC_API_KEY, room: { code: c, team: a.room.team, v: a.room.v, decisions: a.room.decisions || {} }, me: pubMember(a.m) });
    }

    if (route === "room" && req.method === "PUT") {
      const c = q("code").toUpperCase();
      const room = await authManager(c, q("key"));
      if (!room) return json({ error: "Only the manager can change the room" }, 403);
      const b = await body(req);
      if (b.decisions !== undefined && !isObj(b.decisions)) return json({ error: "bad decisions" }, 400);
      if (b.notes !== undefined && !isObj(b.notes)) return json({ error: "bad notes" }, 400);
      if (b.decisions) room.decisions = b.decisions;
      if (b.notes) room.notes = b.notes;
      if (b.team) room.team = clean(b.team, 60);
      room.v = (room.v || 0) + 1;
      room.updated = Date.now();
      await store.setJSON(roomKey(c), room);
      return json({ ok: true, v: room.v });
    }

    if (route === "join" && req.method === "POST") {
      const b = await body(req);
      const c = clean(b.code, 6).toUpperCase();
      const room = await getRoom(c);
      if (!room) return json({ error: "No room with this code" }, 404);
      const name = clean(b.name, 40);
      if (name.length < 2) return json({ error: "Please enter your name" }, 400);
      const { blobs } = await store.list({ prefix: `members/${c}/` });
      if (blobs.length >= MAX_MEMBERS) return json({ error: "This room is full" }, 409);
      const mid = "u_" + rnd(10, TOK_ABC), tok = rnd(24, TOK_ABC);
      await store.setJSON(memKey(c, mid), { mid, name, role: "member", joined: Date.now(), tokHash: await sha(tok), d: {}, done: {} });
      return json({ mid, tok, name, team: room.team, code: c });
    }

    if (route === "member" && req.method === "PUT") {
      const c = q("code").toUpperCase();
      let a = await authMember(c, q("mid"), q("tok"));
      if (!a && q("key")) { // the manager can write their own member record with the manager key
        const room = await authManager(c, q("key"));
        const m = room && q("mid") === room.managerMid ? await getMember(c, q("mid")) : null;
        if (m) a = { room, m };
      }
      if (!a) return json({ error: "Not a member of this room" }, 403);
      const b = await body(req);
      if (b.d !== undefined && !isObj(b.d)) return json({ error: "bad data" }, 400);
      if (b.done !== undefined && !isObj(b.done)) return json({ error: "bad data" }, 400);
      if (b.d) a.m.d = b.d;
      if (b.done) a.m.done = b.done;
      a.m.updated = Date.now();
      await store.setJSON(memKey(c, a.m.mid), a.m);
      return json({ ok: true });
    }

    if (route === "member" && req.method === "DELETE") { // manager removes a teammate (and their answers)
      const c = q("code").toUpperCase();
      const room = await authManager(c, q("key"));
      if (!room) return json({ error: "Only the manager can remove people" }, 403);
      const mid = q("mid");
      if (mid === room.managerMid) return json({ error: "The manager cannot be removed" }, 400);
      const m = await getMember(c, mid);
      if (!m) return json({ ok: true });
      if (m.role === "manager") return json({ error: "The manager cannot be removed" }, 400);
      await store.delete(memKey(c, mid));
      return json({ ok: true });
    }

    if (route === "ai" && req.method === "POST") {
      const b = await body(req);
      const c = clean(b.code, 6).toUpperCase();
      const ok = b.key ? await authManager(c, b.key) : (await authMember(c, clean(b.mid, 24), clean(b.tok, 40)))?.room;
      if (!ok) return json({ error: "Not allowed" }, 403);
      if (!process.env.ANTHROPIC_API_KEY) return json({ error: "AI is not configured on this site" }, 501);
      const day = new Date().toISOString().slice(0, 10), ck = `ai/${c}/${day}`;
      const used = (await store.get(ck, { type: "json" })) || { n: 0 };
      if (used.n >= AI_PER_DAY) return json({ error: "Daily AI limit reached for this room" }, 429);
      await store.setJSON(ck, { n: used.n + 1 });
      const out = await runAI(clean(b.task, 20), b.payload || {});
      return json(out);
    }

    return json({ error: "Not found" }, 404);
  } catch (e) {
    console.error(e);
    return json({ error: e.status ? e.message : "Server error" }, e.status || 500);
  }
};

export const config = { path: "/api/*" };

/* ---------------- AI ---------------- */
const SYSTEM = `You are the AI assistant inside "Decision Room", a tool that helps teams avoid the ways smart teams make bad decisions: groupthink, confirmation bias, anchoring, hidden knowledge (shared-information bias), overconfidence and deferring to the boss. You draw on decision science (Janis, Kahneman & Tversky, Klein's pre-mortem, Edmondson's psychological safety, Woolley et al. 2010 on collective intelligence).
Rules: be concrete and specific to the decision given; never invent facts or numbers that are not in the input; short plain sentences; reply with ONE JSON object only, no markdown fences.`;

const TASKS = {
  devil: (p) => `Act as a devil's advocate for this decision. Give the 3 strongest arguments AGAINST the direction the team is leaning, and 3 sharp questions the team has not answered yet.
JSON shape: {"arguments":["..."],"questions":["..."]}
Decision data: ${JSON.stringify(p)}`,
  scan: (p) => `Scan the team's private answers and challenges for signs of these traps: groupthink, confirm (confirmation bias), anchor (anchoring), hidden (hidden knowledge not shared), overconf (overconfidence), authority (deferring to the boss). Only report traps with evidence in the data.
JSON shape: {"traps":[{"id":"groupthink","evidence":"...","fix":"..."}],"overall":"one sentence"}
Data: ${JSON.stringify(p)}`,
  assume: (p) => `List the hidden assumptions this decision depends on and the main risks. Mark an assumption critical if the decision fails when it is false. Likelihood l and impact i are 1 (low) to 3 (high).
JSON shape: {"assumptions":[{"text":"...","critical":true}],"risks":[{"text":"...","l":2,"i":3,"fix":"..."}]}
Max 4 assumptions and 4 risks. Decision: ${JSON.stringify(p)}`,
  plan: (p) => `Write a short action plan that closes the open gaps before and after this decision. Each action must be specific and doable; days = suggested days from today.
JSON shape: {"actions":[{"text":"...","days":7}]}
Max 6 actions. Data: ${JSON.stringify(p)}`,
  summary: (p) => `Write a 3-sentence executive summary of this decision report for a senior manager: whether the team looks ready, the single most important open issue, and the next step.
JSON shape: {"summary":"..."}
Report: ${String(p.report || "").slice(0, 12000)}`,
  coach: (p) => `A team member is giving their private view on a decision. Ask them ONE probing question that helps them think more independently (e.g. about evidence, what they know that others might not, or what would change their mind). Do not tell them what to vote.
JSON shape: {"question":"..."}
Data: ${JSON.stringify(p)}`
};

async function runAI(task, payload) {
  const make = TASKS[task];
  if (!make) throw Object.assign(new Error("Unknown AI task"), { status: 400 });
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: process.env.AI_MODEL || "claude-sonnet-5-5", max_tokens: 1000, system: SYSTEM, messages: [{ role: "user", content: make(payload).slice(0, 30000) }] })
  });
  if (!r.ok) { console.error("AI error", r.status, await r.text()); throw Object.assign(new Error("The AI service returned an error"), { status: 502 }); }
  const data = await r.json();
  const text = (data.content || []).map((c) => c.text || "").join("");
  const m = text.match(/\{[\s\S]*\}/);
  try { return { ok: true, task, result: JSON.parse(m ? m[0] : text) }; }
  catch { return { ok: true, task, result: { text } }; }
}
