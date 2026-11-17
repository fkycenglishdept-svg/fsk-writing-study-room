const MODEL = "gemini-3.5-flash-lite";
const ORIGIN = "https://fkycenglishdept-svg.github.io";
const API_ROOT = "https://generativelanguage.googleapis.com/v1beta/models/";

let cachedVertexToken = { value: "", expiresAt: 0 };
function hasVertexSettings(env) {
  return Boolean(env.VERTEX_AI_PROJECT_ID || env.VERTEX_AI_SERVICE_ACCOUNT_EMAIL || env.VERTEX_AI_PRIVATE_KEY);
}
function hasVertexCredentials(env) {
  return Boolean(env.VERTEX_AI_PROJECT_ID && env.VERTEX_AI_SERVICE_ACCOUNT_EMAIL && env.VERTEX_AI_PRIVATE_KEY);
}
function base64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
function pemBytes(pem) {
  const encoded = String(pem || "").replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g, "");
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}
async function getVertexAccessToken(env) {
  if (cachedVertexToken.value && cachedVertexToken.expiresAt > Date.now() + 60_000) return cachedVertexToken.value;
  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(new TextEncoder().encode(JSON.stringify({ alg: "RS256", typ: "JWT" })));
  const claims = base64Url(new TextEncoder().encode(JSON.stringify({
    iss: env.VERTEX_AI_SERVICE_ACCOUNT_EMAIL,
    scope: "https://www.googleapis.com/auth/cloud-platform",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600
  })));
  const unsigned = header + "." + claims;
  const privateKey = String(env.VERTEX_AI_PRIVATE_KEY).replace(/\\n/g, "\n");
  const key = await crypto.subtle.importKey("pkcs8", pemBytes(privateKey), {
    name: "RSASSA-PKCS1-v1_5", hash: "SHA-256"
  }, false, ["sign"]);
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned));
  const assertion = unsigned + "." + base64Url(new Uint8Array(signature));
  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=" + encodeURIComponent(assertion),
    signal: AbortSignal.timeout(15_000)
  });
  const tokenData = await tokenResponse.json().catch(() => ({}));
  if (!tokenResponse.ok || typeof tokenData.access_token !== "string") {
    throw new Error("Google Cloud 驗證失敗，請檢查 Vertex AI 服務帳戶金鑰及權限。");
  }
  cachedVertexToken = { value: tokenData.access_token, expiresAt: Date.now() + Number(tokenData.expires_in || 3600) * 1000 };
  return cachedVertexToken.value;
}

const SYSTEM_INSTRUCTION = `你是「寫作研習室」的繁體中文 AI 學習教練，也能直接回答學生提出的一般問題。先回答學生真正問的內容，再視乎需要給一個簡短、可行的下一步；不要把每個問題都硬轉成下一題，也不要只回覆模板。用清楚、友善、適合中學生的香港繁體中文；若學生用其他語言，可配合回答。

寫作任務脈絡：題目、寫作要求、評分準則、目前階段、立場、兩個分論點及各自事例、一個駁論都會在使用者訊息中提供。學生目前希望完成兩個互不重複的分論點，各配合適事例，並寫一個駁論。只在相關時使用這個脈絡，回答其他問題時不要離題。不要替學生直接完成整篇文章；可以解釋概念、提供思路、指出草稿問題及示範短句。

事實與論據規則：學生若要真實事例、歷史事件、論據或最新事實，必須使用提供的 Google Search 搜尋工具核對。只提出搜尋結果支持的事件、人物、年代和結果；簡短說明該事件如何支持學生目前的分論點，並保留來源的不確定或爭議。搜尋不到可靠來源時，清楚說目前未能核實，請勿猜測、杜撰或把虛構故事當真事。事件可來自中國古代、中國現代、西方古代或西方現代。不要為學生提供看似真實但無來源的例子。其他一般知識問題亦要誠實處理，不確定時直說。不要聲稱已修改或儲存學生資料。`;

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
function isDraftAnswerCandidate(message, stage, pointIndex) {
  const value = String(message || "").trim();
  const compact = value.replace(/\s/g, "").replace(/[，。！？、；：,.!?]/g, "");
  if (!compact || /[？?]|嗎|請問|可否|能否|可以嗎|是否|怎樣|如何|為甚麼|為什麼|點解|解釋|介紹|提供|有甚麼|有什麼|幫我|想知道/.test(value)) return false;
  if (/^(好|好的|嗯+|哦+|喔+|是|係|對|明白|知道了|收到|謝謝|唔該|ok|okay|yes|no|thanks)$/i.test(compact)) return false;
  if (/想不到|想不出|不知道|唔知|沒有例子|沒有事例|未能舉例|不懂/.test(value)) return false;
  if (stage === 0) return compact.length >= 3 && /同意|不同意|部分認同|贊成|反對|支持|不支持|認為|立場|讀書有用|讀書無用/.test(value);
  if (stage === 1) return compact.length >= 8 && /因為|可以|能夠|有助|令|使|讓|學到|培養|提高|增加|改善|促進|提供|有利|重要|價值|機會|能力/.test(value);
  if (stage === 2) return compact.length >= 6 && /\d{3,4}|事件|戰役|戰爭|改革|制度|革命|運動|協定|法案|發明|成立|建立|頒布|推行|提出|發現|創立|朝|年|世紀|王|帝|文藝復興|工業革命|科舉|啟蒙/.test(value);
  if (stage === 3 && pointIndex === 0) return compact.length >= 8 && /有人|反方|認為|會說|因為|理由|可能|雖然|但是|不過|可是|然而|但/.test(value);
  if (stage === 3 && pointIndex === 1) return compact.length >= 8 && /因為|但是|不過|可是|然而|但|雖然|即使|仍然|不能|未必|不一定|只要|所以|因此|回應|問題/.test(value);
  return false;
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

    if (url.pathname === "/api/essay-status" && request.method === "GET") {
      if (!allowed) return json({ ready: false }, 403, corsOrigin);
      return json({ ready: hasVertexSettings(env) ? hasVertexCredentials(env) : Boolean(env.GEMINI_API_KEY), model: MODEL, provider: hasVertexSettings(env) ? "vertex-ai" : "gemini-api" }, 200, corsOrigin);
    }

    if (url.pathname !== "/api/essay-coach" || request.method !== "POST") {
      return json({ error: "找不到這個服務。" }, 404, corsOrigin);
    }
    if (!allowed) return json({ error: "不允許這個網站呼叫。" }, 403, corsOrigin);
    const vertexRequested = hasVertexSettings(env);
    if (vertexRequested && !hasVertexCredentials(env)) {
      return json({ error: "Vertex AI 設定未完成，請檢查專案 ID、服務帳戶電郵及私密金鑰。" }, 503, corsOrigin);
    }
    if (!vertexRequested && !env.GEMINI_API_KEY) return json({ error: "Gemini 尚未完成伺服器設定。" }, 503, corsOrigin);

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
    const advanceDraft = isDraftAnswerCandidate(message, context.stage, context.pointIndex);
    const body = {
      systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
      contents,
      generationConfig: { maxOutputTokens: 850 }
    };
    if (needsSearch) body.tools = [{ google_search: {} }];

    try {
      let apiUrl, headers, accessToken = "";
      if (vertexRequested) {
        const location = String(env.VERTEX_AI_LOCATION || "global");
        if (!["global", "asia-south1", "us", "eu"].includes(location)) {
          return json({ error: "VERTEX_AI_LOCATION 必須是 global、asia-south1、us 或 eu。" }, 503, corsOrigin);
        }
        accessToken = await getVertexAccessToken(env);
        const host = location === "global" ? "aiplatform.googleapis.com" : location + "-aiplatform.googleapis.com";
        apiUrl = "https://" + host + "/v1/projects/" + encodeURIComponent(env.VERTEX_AI_PROJECT_ID) +
          "/locations/" + location + "/publishers/google/models/" + MODEL + ":generateContent";
        headers = { "Content-Type": "application/json", "Authorization": "Bearer " + accessToken };
      } else {
        apiUrl = API_ROOT + MODEL + ":generateContent?key=" + encodeURIComponent(env.GEMINI_API_KEY);
        headers = { "Content-Type": "application/json" };
      }
      const response = await fetch(apiUrl, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(45_000)
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        const providerMessage = String(result.error?.message || "HTTP " + response.status)
          .replaceAll(accessToken || env.GEMINI_API_KEY || "__NO_SECRET__", "[已隱藏]")
          .replace(/\s+/g, " ")
          .slice(0, 260);
        let error = vertexRequested
          ? "Vertex AI 請求失敗（HTTP " + response.status + "）"
          : "Gemini API 請求失敗（HTTP " + response.status + "）";
        if (response.status === 401 || response.status === 403) {
          error = vertexRequested ? "Vertex AI 服務帳戶或 IAM 權限有問題（HTTP " + response.status + "）"
            : "Gemini API Key 或權限有問題（HTTP " + response.status + "）";
        } else if (response.status === 404) error = "Gemini 模型或 API 路徑不存在（HTTP 404）";
        else if (response.status === 429) error = vertexRequested ? "Vertex AI 額度或速率限制（HTTP 429）" : "Gemini 額度或速率限制（HTTP 429）";
        return json({ error: `${error}：${providerMessage}` }, response.status === 429 ? 429 : 502, corsOrigin);
      }

      const candidate = result.candidates?.[0];
      let answer = (candidate?.content?.parts || []).map(part => part.text || "").join("").trim();
      if (!answer) return json({ error: "Gemini 沒有傳回文字答案，請重試。" }, 502, corsOrigin);

      const chunks = candidate?.groundingMetadata?.groundingChunks || [];
      const sources = chunks
        .map(chunk => chunk.web)
        .filter(web => web && typeof web.uri === "string" && /^https:\/\//i.test(web.uri))
        .slice(0, 5);
      if (needsSearch && sources.length) {
        answer += "\n\n參考來源：\n" + sources.map((source, index) =>
          (index + 1) + ". " + String(source.title || "網頁來源").slice(0, 140) + " — " + source.uri
        ).join("\n");
      } else if (needsSearch && hasChineseHistoricalRequest(message)) {
        answer = "我這次未能從搜尋結果取得可核實來源，因此不會把未核對的事件當作真實例子。你可以改用較具體的分論點或事件方向再問一次。";
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
      const timeout = error?.name === "TimeoutError";
      const message = String(error?.message || "");
      const safeError = timeout ? "AI 回覆逾時，請重試。"
        : vertexRequested
          ? (message.startsWith("Google Cloud 驗證失敗") ? message : "Vertex AI 連線或驗證失敗，請檢查服務帳戶設定及權限。")
          : "暫時無法連接 Gemini，請稍後再試。";
      return json({ error: safeError }, 502, corsOrigin);
    }
  }
};
