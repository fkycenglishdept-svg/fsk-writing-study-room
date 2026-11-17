const MODEL = "@cf/qwen/qwen3.8-27b";
const ORIGIN = "https://fkycenglishdept-svg.github.io";

const SYSTEM_INSTRUCTION = `你是「寫作研習室」的繁體中文 AI 學習教練，也能直接回答學生提出的一般問題。先回答學生真正問的內容，再視乎需要給一個簡短、可行的下一步；不要把每個問題都硬轉成下一題，也不要只回覆模板。用清楚、友善、適合中學生的香港繁體中文；若學生用其他語言，可配合回答。

寫作任務脈絡：題目、寫作要求、評分準則、目前階段、立場、兩個分論點及各自事例、一個駁論都會在使用者訊息中提供。學生目前希望完成兩個互不重複的分論點，各配合適事例，並寫一個駁論。只在相關時使用這個脈絡，回答其他問題時不要離題。不要替學生直接完成整篇文章；可以解釋概念、提供思路、指出草稿問題及示範短句。

事實與論據規則：學生若要求真實事例、歷史事件或論據，先查閱隨訊息提供的維基百科搜尋摘要和頁面連結。只能提出摘要支持的事件、人物、年代和結果；說明事件如何支持學生目前的分論點，並附上來源連結。搜尋不到來源時，不要猜測、杜撰或把虛構故事當真事，須清楚說目前未能核實。維基百科摘要是查找線索，不代表所有內容均為一手史料；如有爭議，提醒學生進一步查看條目所列來源。一般知識問題要誠實處理，不確定時直說。不要聲稱已修改或儲存學生資料。`;

const buckets = new Map();
function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin"
  };
}
function json(data, status, origin) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders(origin), "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
  });
}
function eventRequest(text) {
  return /論據|事例|例子|事件|真實|歷史|證據|最新|最近|現在|目前|今天|今年|現時/.test(text);
}
function rateAllowed(ip) {
  const now = Date.now();
  const slot = buckets.get(ip);
  if (!slot || now - slot.start >= 60_000) {
    buckets.set(ip, { start: now, count: 1 });
    if (buckets.size > 3000) {
      for (const [key, value] of buckets) if (now - value.start >= 60_000) buckets.delete(key);
    }
    return true;
  }
  if (slot.count >= 18) return false;
  slot.count += 1;
  return true;
}
function cleanHistory(value) {
  if (!Array.isArray(value)) return [];
  const turns = [];
  for (const m of value.slice(-12)) {
    if (!m || typeof m.text !== "string") continue;
    const role = m.from === "coach" ? "model" : "user";
    const text = m.text.slice(0, 3000);
    if (turns.length === 0 && role === "model") continue;
    const last = turns[turns.length - 1];
    if (last && last.role === role) last.parts[0].text += "\n" + text;
    else turns.push({ role, parts: [{ text }] });
  }
  return turns;
}
function hasChineseHistoricalRequest(text) {
  return /中國|西方|古代|歷史|事件|真實|論據|事例|例子|最新|最近|今天|今年/.test(text);
}
async function searchHistoricalSources(query) {
  try {
    const url = new URL("https://zh.wikipedia.org/w/api.php");
    url.search = new URLSearchParams({
      action: "query", list: "search", srsearch: query.slice(0, 220),
      srlimit: "4", format: "json", utf8: "1"
    }).toString();
    const response = await fetch(url, {
      headers: { "Accept": "application/json", "Api-User-Agent": "fsk-writing-study-room/1.0 (school writing coach)" },
      signal: AbortSignal.timeout(8000)
    });
    if (!response.ok) return [];
    const data = await response.json();
    return (data.query?.search || []).slice(0, 4).map(item => ({
      title: String(item.title || "").slice(0, 140),
      snippet: String(item.snippet || "").replace(/<[^>]*>/g, "").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").slice(0, 700),
      uri: "https://zh.wikipedia.org/wiki/" + encodeURIComponent(String(item.title || "").replace(/ /g, "_"))
    })).filter(item => item.title && item.snippet);
  } catch { return []; }
}

export class ClassroomStore {
  constructor(ctx, env) { this.ctx = ctx; this.env = env; }
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/save") {
      let record;
      try { record = await request.json(); } catch { return new Response("bad request", { status: 400 }); }
      const key = typeof record.sessionId === "string" && /^[a-zA-Z0-9_-]{16,80}$/.test(record.sessionId) ? record.sessionId : "";
      if (!key) return new Response("invalid session id", { status: 400 });
      const now = Date.now();
      const previous = await this.ctx.storage.get("session:" + key);
      const messages = Array.isArray(record.messages) ? record.messages.slice(-80).filter(m => m && typeof m.text === "string").map(m => ({ from: m.from === "student" ? "student" : "coach", text: m.text.slice(0, 1800) })) : [];
      const safe = {
        sessionId: key, studentLabel: String(record.studentLabel || "學生").trim().slice(0, 80),
        topic: String(record.topic || "").slice(0, 500),
        stage: Math.max(0, Math.min(4, Number(record.stage) || 0)),
        stageLabel: String(record.stageLabel || "").slice(0, 80),
        progress: Math.max(0, Math.min(100, Number(record.progress) || 0)),
        draft: record.draft && typeof record.draft === "object" ? record.draft : {},
        messages, createdAt: previous?.createdAt || now, updatedAt: now,
        expiresAt: now + 30 * 24 * 60 * 60 * 1000
      };
      if (JSON.stringify(safe).length > 90_000) return new Response("record too large", { status: 413 });
      await this.ctx.storage.put("session:" + key, safe);
      await this.prune(now);
      return Response.json({ ok: true });
    }
    if (request.method === "GET" && url.pathname === "/list") {
      const now = Date.now(), records = await this.ctx.storage.list({ prefix: "session:", limit: 250 }), sessions = [];
      for (const [key, value] of records) {
        if (value?.expiresAt > now) sessions.push(value);
        else await this.ctx.storage.delete(key);
      }
      sessions.sort((a, b) => b.updatedAt - a.updatedAt);
      return Response.json({ sessions: sessions.slice(0, 150) });
    }
    return new Response("not found", { status: 404 });
  }
  async prune(now) {
    const records = await this.ctx.storage.list({ prefix: "session:", limit: 250 });
    const sorted = [...records.entries()].sort((a, b) => (b[1]?.updatedAt || 0) - (a[1]?.updatedAt || 0));
    for (let i = 0; i < sorted.length; i++) {
      if (sorted[i][1]?.expiresAt <= now || i >= 150) await this.ctx.storage.delete(sorted[i][0]);
    }
  }
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const allowed = origin === ORIGIN;
    const corsOrigin = allowed ? origin : ORIGIN;
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      if (!allowed) return new Response(null, { status: 403 });
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    if (url.pathname === "/api/classroom/session" && request.method === "POST") {
      if (!allowed) return json({ error: "不允許這個網站呼叫。" }, 403, corsOrigin);
      if (!env.CLASSROOM_STORE) return json({ error: "課堂記錄服務尚未設定。" }, 503, corsOrigin);
      const length = Number(request.headers.get("Content-Length") || 0);
      if (length > 100_000) return json({ error: "對話紀錄太大。" }, 413, corsOrigin);
      let record;
      try { record = await request.json(); } catch { return json({ error: "記錄格式不正確。" }, 400, corsOrigin); }
      const id = typeof record.sessionId === "string" && /^[a-zA-Z0-9_-]{16,80}$/.test(record.sessionId) ? record.sessionId : "";
      if (!id) return json({ error: "對話識別碼不正確。" }, 400, corsOrigin);
      try {
        const stub = env.CLASSROOM_STORE.get(env.CLASSROOM_STORE.idFromName("classroom"));
        const stored = await stub.fetch("https://classroom-store/save", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(record) });
        if (!stored.ok) return json({ error: "無法保存課堂紀錄。" }, 502, corsOrigin);
        return json({ saved: true }, 200, corsOrigin);
      } catch { return json({ error: "暫時無法保存課堂紀錄。" }, 502, corsOrigin); }
    }

    if (url.pathname === "/api/classroom/sessions" && request.method === "GET") {
      if (!allowed) return json({ error: "不允許這個網站呼叫。" }, 403, corsOrigin);
      if (!env.CLASSROOM_STORE) return json({ error: "課堂記錄服務尚未設定。" }, 503, corsOrigin);
      try {
        const stub = env.CLASSROOM_STORE.get(env.CLASSROOM_STORE.idFromName("classroom"));
        const stored = await stub.fetch("https://classroom-store/list");
        if (!stored.ok) return json({ error: "無法載入課堂紀錄。" }, 502, corsOrigin);
        return json(await stored.json(), 200, corsOrigin);
      } catch { return json({ error: "暫時無法載入課堂紀錄。" }, 502, corsOrigin); }
    }

    if (url.pathname === "/api/essay-status" && request.method === "GET") {
      if (!allowed) return json({ ready: false }, 403, corsOrigin);
      return json({ ready: Boolean(env.AI), model: MODEL }, 200, corsOrigin);
    }

    if (url.pathname !== "/api/essay-coach" || request.method !== "POST") {
      return json({ error: "找不到這個服務。" }, 404, corsOrigin);
    }
    if (!allowed) return json({ error: "不允許這個網站呼叫。" }, 403, corsOrigin);
    if (!env.AI) return json({ error: "Cloudflare Workers AI binding 尚未設定。" }, 503, corsOrigin);

    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    if (!rateAllowed(ip)) return json({ error: "送出太頻密，請稍等一分鐘再試。" }, 429, corsOrigin);

    const length = Number(request.headers.get("Content-Length") || 0);
    if (length > 32_000) return json({ error: "訊息太長，請縮短後再送出。" }, 413, corsOrigin);

    let input;
    try { input = await request.json(); }
    catch { return json({ error: "訊息格式不正確。" }, 400, corsOrigin); }

    const message = typeof input.message === "string" ? input.message.trim().slice(0, 2500) : "";
    if (!message) return json({ error: "請先輸入問題或想法。" }, 400, corsOrigin);

    const context = {
      topic: String(input.topic || "").slice(0, 500),
      assignment: String(input.prompt || "").slice(0, 1600),
      rubrics: Array.isArray(input.rubrics) ? input.rubrics.slice(0, 8).map(x => String(x).slice(0, 120)) : [],
      stage: Number.isFinite(Number(input.stage)) ? Math.max(0, Math.min(4, Number(input.stage))) : 0,
      pointIndex: Number.isFinite(Number(input.pointIndex)) ? Math.max(0, Math.min(1, Number(input.pointIndex))) : 0,
      target: "兩個分論點、各配一件事例、一個駁論",
      draft: input.draft && typeof input.draft === "object" ? input.draft : {}
    };
    const contents = cleanHistory(input.messages);
    const currentText = "【目前寫作脈絡】\n" + JSON.stringify(context) +
      "\n\n【學生現在的訊息】\n" + message;
    const lastTurn = contents[contents.length - 1];
    if (lastTurn && lastTurn.role === "user") lastTurn.parts[0].text += "\n\n" + currentText;
    else contents.push({ role: "user", parts: [{ text: currentText }] });

    const needsSearch = eventRequest(message) || hasChineseHistoricalRequest(message);
    const asksForHelp = /[？?]|請問|可否|能否|怎樣|如何|為甚麼|為什麼|點解|解釋|介紹|提供|有甚麼|有什麼/.test(message);
    const advanceDraft = !asksForHelp;

    try {
      let sources = [];
      if (needsSearch) {
        const point = context.draft?.points?.[context.pointIndex]?.claim || "";
        const query = [context.topic, point, message].filter(Boolean).join(" ").slice(0, 220);
        sources = await searchHistoricalSources(query);
        const sourceNote = sources.length
          ? "【維基百科搜尋摘要，僅供核對線索】\n" + JSON.stringify(sources)
          : "【搜尋未找到可用來源】不要提供未核實的具體歷史事件；明確告知學生目前未能核實。";
        contents.push({ role: "user", parts: [{ text: sourceNote }] });
      }
      const messages = [
        { role: "system", content: SYSTEM_INSTRUCTION },
        ...contents.map(turn => ({
          role: turn.role === "model" ? "assistant" : "user",
          content: turn.parts.map(part => part.text || "").join("\n")
        }))
      ];
      const result = await env.AI.run(MODEL, { messages, max_tokens: 850, temperature: 0.35 });
      let answer = String(result?.response || result?.choices?.[0]?.message?.content || "").trim();
      if (!answer) return json({ error: "Cloudflare AI 沒有傳回文字答案，請重試。" }, 502, corsOrigin);

      if (needsSearch && sources.length) {
        answer += "\n\n參考來源：\n" + sources.map((source, index) =>
          (index + 1) + ". " + source.title + " — " + source.uri
        ).join("\n");
      } else if (needsSearch && hasChineseHistoricalRequest(message)) {
        answer = "我這次未能找到可供核實的資料來源，因此不會把未核對的事件當作真實論據。你可以提供更具體的分論點或事件名稱，再讓我查找。";
      }

      return json({
        message: answer.slice(0, 7500),
        needsSupport: false,
        supportKind: "",
        evidenceIds: [],
        model: MODEL,
        grounded: sources.length > 0,
        advanceDraft
      }, 200, corsOrigin);
    } catch (error) {
      const detail = String(error?.message || "");
      const limited = Number(error?.status || error?.statusCode) === 429 || /quota|rate.?limit|daily.*limit/i.test(detail);
      return json({ error: limited
        ? "Cloudflare AI 今日額度或速率受限（HTTP 429），請稍後再試。"
        : "暫時無法連接 Cloudflare AI，請稍後再試。" }, limited ? 429 : 502, corsOrigin);
    }
  }
};
