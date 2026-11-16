const MODEL = "gemini-3.8-flash";
const ORIGIN = "https://fkycenglishdept-svg.github.io";
const API_ROOT = "https://generativelanguage.googleapis.com/v1beta/models/";

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
  return value.slice(-12).flatMap((m) => {
    if (!m || typeof m.text !== "string") return [];
    const text = m.text.slice(0, 3000);
    return [{ role: m.from === "coach" ? "model" : "user", parts: [{ text }] }];
  });
}
function hasChineseHistoricalRequest(text) {
  return /中國|西方|古代|歷史|事件|真實|論據|事例|例子|最新|最近|今天|今年/.test(text);
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
      return json({ ready: Boolean(env.GEMINI_API_KEY), model: MODEL }, 200, corsOrigin);
    }

    if (url.pathname !== "/api/essay-coach" || request.method !== "POST") {
      return json({ error: "找不到這個服務。" }, 404, corsOrigin);
    }
    if (!allowed) return json({ error: "不允許這個網站呼叫。" }, 403, corsOrigin);
    if (!env.GEMINI_API_KEY) return json({ error: "Gemini 尚未完成伺服器設定。" }, 503, corsOrigin);

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
    contents.push({
      role: "user",
      parts: [{
        text: "【目前寫作脈絡】\n" + JSON.stringify(context) +
          "\n\n【學生現在的訊息】\n" + message
      }]
    });

    const needsSearch = eventRequest(message) || hasChineseHistoricalRequest(message);
    const asksForHelp = /[？?]|請問|可否|能否|怎樣|如何|為甚麼|為什麼|點解|解釋|介紹|提供|有甚麼|有什麼/.test(message);
    const advanceDraft = !asksForHelp;
    const body = {
      systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
      contents,
      generationConfig: { maxOutputTokens: 850 }
    };
    if (needsSearch) body.tools = [{ google_search: {} }];

    try {
      const response = await fetch(API_ROOT + MODEL + ":generateContent?key=" + encodeURIComponent(env.GEMINI_API_KEY), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(45_000)
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        const status = response.status === 429 ? 429 : 502;
        return json({ error: status === 429 ? "Gemini 暫時繁忙，請稍後再試。" : "Gemini 暫時未能回答，請稍後再試。" }, status, corsOrigin);
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
      return json({ error: timeout ? "Gemini 回覆逾時，請重試。" : "暫時無法連接 Gemini，請稍後再試。" }, 502, corsOrigin);
    }
  }
};
