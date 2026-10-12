const DEFAULT_MODEL = "gemini-3.5-flash-lite";
const MAX_HISTORY_MESSAGES = 8;
const MAX_HISTORY_MESSAGE_CHARS = 1200;
const MAX_ALICE_TEXT = 1024;
const TOTAL_RESPONSE_BUDGET_MS = 3600;
const SERPER_TIMEOUT_MS = 600;
const GEMINI_TIMEOUT_MS = 2500;

// Yandex Dialogs rejects the whole response when a state object is larger than
// 1 KB, which the skill reports as a server error. Cyrillic text costs two bytes
// per character in UTF-8, so every state object is measured in bytes and packed
// against a budget with a safety margin instead of a character count.
const STATE_BYTE_LIMIT = 1024;
const STATE_BYTE_BUDGET = 900;
// A model answer is long and a user question is short, so the question keeps a
// larger share of the budget: it is what makes a follow-up like "а на выходных?"
// understandable, while the answer only needs its gist.
const MAX_STATE_USER_CHARS = 280;
const MAX_STATE_MODEL_CHARS = 160;
const MAX_MEMORY_TOPICS = 3;
const MAX_MEMORY_TOPIC_CHARS = 80;
const MIN_MEMORY_TOPIC_CHARS = 4;
const MAX_MEMORY_NAME_CHARS = 32;

const SYSTEM_PROMPT = [
  "Ты — полезный голосовой помощник в навыке Яндекс Алисы.",
  "Отвечай естественно, по-русски, кратко и так, чтобы ответ было удобно слушать.",
  "Обычно используй 1–3 коротких предложения. Не используй Markdown, таблицы, списки с символами или длинные вступления.",
  "Если вопрос требует актуальных данных и переданы результаты поиска, опирайся на них; не выдумывай отсутствующие факты.",
  "Если не знаешь ответа, честно скажи об этом."
].join(" ");

function byteLength(value) {
  return Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");
}

function fitAliceText(value) {
  const text = String(value ?? "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();

  if (text.length <= MAX_ALICE_TEXT) return text || "Не удалось подготовить ответ.";

  const candidate = text.slice(0, MAX_ALICE_TEXT - 1);
  const sentenceEnd = Math.max(
    candidate.lastIndexOf(". "),
    candidate.lastIndexOf("! "),
    candidate.lastIndexOf("? ")
  );
  if (sentenceEnd >= 300) return candidate.slice(0, sentenceEnd + 1).trim();

  const lastSpace = candidate.lastIndexOf(" ");
  return (lastSpace > 200 ? candidate.slice(0, lastSpace) : candidate).trim() + "…";
}

function clip(value, maxChars) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (text.length <= maxChars) return text;
  const candidate = text.slice(0, maxChars);
  const lastSpace = candidate.lastIndexOf(" ");
  return (lastSpace > maxChars / 2 ? candidate.slice(0, lastSpace) : candidate).trim();
}

function isSearchIntent(text) {
  return /\b(latest|today|current|news|weather|price|exchange rate|recent|search|look up)\b|сегодня|сейчас|последн|новост|погод|курс валют|найди|поищи|актуальн|сколько стоит|свежие данные/i.test(text);
}

// Matched against the whole utterance: `\b` does not work after Cyrillic in
// JavaScript, and short words like "пока" only mean goodbye on their own
// ("пока что расскажи…" must not end the session).
const EXIT_PHRASES = /^((спасибо|ладно|хорошо|ок|окей)[,!.\s]+)?(хватит|стоп|выход|выйти|пока|пока-пока|до\s+свидания|досвидания|прощай|закончи(ть)?|заверши(ть)?|отмена|вс[её])([,!.\s]+(спасибо|пожалуйста))?[\s.!,]*$/i;

function isExitIntent(text) {
  return EXIT_PHRASES.test(text.trim());
}

function isForgetIntent(text) {
  return /забудь (вс[её]|мен[яе]|про меня)|очисти(ть)? память|сброс(ь|ить)? память|удали (мои |все )?данные/i.test(text);
}

// ---------------------------------------------------------------------------
// Session state: the running dialogue history
// ---------------------------------------------------------------------------

// Stored entries use short keys ({ r, t }) so more of the 1 KB budget is left
// for actual text. Entries written by older versions ({ role, text }) are still
// read, so an already deployed skill keeps working after the update.
function normalizeHistoryItem(item) {
  if (!item || typeof item !== "object") return null;

  const rawRole = item.role ?? item.r;
  const role = rawRole === "user" || rawRole === "u"
    ? "user"
    : rawRole === "model" || rawRole === "m"
      ? "model"
      : null;

  const rawText = typeof item.text === "string" ? item.text : typeof item.t === "string" ? item.t : null;
  if (!role || rawText === null) return null;

  const text = rawText.slice(0, MAX_HISTORY_MESSAGE_CHARS).trim();
  return text ? { role, text } : null;
}

function safeHistory(history) {
  if (!Array.isArray(history)) return [];
  return history
    .map(normalizeHistoryItem)
    .filter(Boolean)
    .slice(-MAX_HISTORY_MESSAGES);
}

function readHistory(state) {
  const session = state && typeof state === "object" ? state.session : null;
  if (!session || typeof session !== "object") return [];
  return safeHistory(Array.isArray(session.h) ? session.h : session.history);
}

// Fills the byte budget from the newest message backwards, so the most relevant
// turns survive and the result always fits into what Yandex accepts.
function buildSessionState(history) {
  const items = safeHistory(history);
  const packed = [];
  let state = { h: packed };
  let used = byteLength(state);

  for (let i = items.length - 1; i >= 0; i--) {
    const isUser = items[i].role === "user";
    const entry = {
      r: isUser ? "u" : "m",
      t: clip(items[i].text, isUser ? MAX_STATE_USER_CHARS : MAX_STATE_MODEL_CHARS)
    };
    if (!entry.t) continue;

    const cost = byteLength(entry) + (packed.length ? 1 : 0);
    if (used + cost > STATE_BYTE_BUDGET) break;
    used += cost;
    packed.unshift(entry);
  }

  state = { h: packed };
  while (packed.length && byteLength(state) > STATE_BYTE_BUDGET) {
    packed.shift();
    state = { h: packed };
  }
  return byteLength(state) > STATE_BYTE_LIMIT ? { h: [] } : state;
}

// ---------------------------------------------------------------------------
// Application and user state: what the skill remembers between sessions
// ---------------------------------------------------------------------------

function safeMemory(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  const memory = { v: 1 };

  if (typeof source.name === "string") {
    const name = clip(source.name, MAX_MEMORY_NAME_CHARS);
    if (name) memory.name = name;
  }

  const visits = Number(source.n);
  if (Number.isFinite(visits) && visits > 0) memory.n = Math.min(Math.round(visits), 9999);

  if (typeof source.seen === "string" && /^\d{4}-\d{2}-\d{2}$/.test(source.seen)) {
    memory.seen = source.seen;
  }

  if (Array.isArray(source.topics)) {
    const topics = source.topics
      .filter(topic => typeof topic === "string")
      .map(topic => clip(topic, MAX_MEMORY_TOPIC_CHARS))
      .filter(Boolean)
      .slice(0, MAX_MEMORY_TOPICS);
    if (topics.length) memory.topics = topics;
  }

  return memory;
}

// The user cut only exists for accounts signed in with Yandex ID, so the
// application cut (per device or app) is the fallback and the two are merged.
function readMemory(state) {
  const source = state && typeof state === "object" ? state : {};
  const application = safeMemory(source.application);
  const user = safeMemory(source.user);

  const memory = { v: 1 };
  const name = user.name || application.name;
  if (name) memory.name = name;

  const visits = Math.max(user.n || 0, application.n || 0);
  if (visits) memory.n = visits;

  const seen = [user.seen, application.seen].filter(Boolean).sort().pop();
  if (seen) memory.seen = seen;

  const topics = [...(user.topics || []), ...(application.topics || [])];
  const unique = [];
  for (const topic of topics) {
    if (!unique.some(item => item.toLowerCase() === topic.toLowerCase())) unique.push(topic);
    if (unique.length === MAX_MEMORY_TOPICS) break;
  }
  if (unique.length) memory.topics = unique;

  return memory;
}

function extractName(text) {
  const match = /(?:меня зовут|мо[её] имя|зови меня|я —)[\s—-]*([A-Za-zА-Яа-яЁё][A-Za-zА-Яа-яЁё-]{1,31})/i.exec(text);
  if (!match) return "";
  const name = match[1];
  if (/^(не|да|нет|пожалуйста|никак|просто|человек)$/i.test(name)) return "";
  return name.charAt(0).toUpperCase() + name.slice(1);
}

function updateMemory(memory, { text, isNewSession, now = new Date() }) {
  const next = { ...memory, v: 1 };

  const name = extractName(text);
  if (name) next.name = clip(name, MAX_MEMORY_NAME_CHARS);
  if (isNewSession) next.n = Math.min((Number(next.n) || 0) + 1, 9999);
  next.seen = now.toISOString().slice(0, 10);

  // Filler turns are not worth one of the three remembered topic slots.
  const topic = clip(text, MAX_MEMORY_TOPIC_CHARS);
  if (topic.length >= MIN_MEMORY_TOPIC_CHARS && !/^(да|нет|ага|угу|ещ[её]|дальше|спасибо|привет|алиса)[\s.!,?]*$/i.test(topic)) {
    const topics = (next.topics || []).filter(item => item.toLowerCase() !== topic.toLowerCase());
    next.topics = [topic, ...topics].slice(0, MAX_MEMORY_TOPICS);
  }

  return next;
}

// Last line of defence: shrink the object until it fits, and give up on it
// entirely rather than letting Yandex reject the whole response.
function fitMemory(memory) {
  let candidate = { ...memory };

  while (Array.isArray(candidate.topics) && candidate.topics.length && byteLength(candidate) > STATE_BYTE_BUDGET) {
    const topics = candidate.topics.slice(0, -1);
    candidate = { ...candidate };
    if (topics.length) candidate.topics = topics;
    else delete candidate.topics;
  }

  for (const key of ["seen", "n", "name"]) {
    if (byteLength(candidate) <= STATE_BYTE_BUDGET) break;
    delete candidate[key];
  }

  return byteLength(candidate) <= STATE_BYTE_LIMIT ? candidate : null;
}

function memoryContext(memory) {
  const parts = [];
  if (memory.name) parts.push(`Пользователя зовут ${memory.name}.`);
  if (memory.n > 1) parts.push(`Вы общались и раньше, это разговор номер ${memory.n}.`);
  if (memory.topics?.length) parts.push(`Недавние темы разговоров: ${memory.topics.join("; ")}.`);
  if (!parts.length) return "";
  return `Что ты помнишь об этом пользователе: ${parts.join(" ")} Используй это, только если это уместно, и не пересказывай без просьбы.`;
}

function greetingFor(memory) {
  if (memory.name) return `С возвращением, ${memory.name}! О чём поговорим?`;
  if (memory.n > 1 && memory.topics?.length) {
    return `Снова привет! В прошлый раз мы говорили про ${memory.topics[0]}. Что узнаем сегодня?`;
  }
  return "Привет! Я могу ответить на вопрос или найти актуальную информацию. Что хочешь узнать?";
}

// ---------------------------------------------------------------------------
// Response envelope
// ---------------------------------------------------------------------------

function aliceResponse(text, endSession = false, history = [], options = {}) {
  const payload = {
    version: "1.0",
    response: {
      text: fitAliceText(text),
      end_session: Boolean(endSession)
    }
  };

  // A finished session has no state to carry, and Yandex drops it anyway.
  if (!endSession) payload.session_state = buildSessionState(history);

  if (options.clearMemory) {
    payload.application_state = {};
    if (options.authorized) {
      payload.user_state_update = { v: null, name: null, n: null, seen: null, topics: null };
    }
    return payload;
  }

  if (options.memory) {
    const memory = fitMemory(options.memory);
    if (memory) {
      payload.application_state = memory;
      if (options.authorized) payload.user_state_update = memory;
    }
  }

  return payload;
}

// ---------------------------------------------------------------------------
// External services
// ---------------------------------------------------------------------------

async function fetchJson(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(100, timeoutMs));
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const data = await response.json().catch(() => ({}));
    return { response, data };
  } finally {
    clearTimeout(timer);
  }
}

async function searchWeb(query, timeoutMs) {
  const key = process.env.SERPER_API_KEY;
  if (!key || timeoutMs < 150) return "";

  try {
    const { response, data } = await fetchJson(
      "https://google.serper.dev/search",
      {
        method: "POST",
        headers: {
          "X-API-KEY": key,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ q: query, gl: "ru", hl: "ru", num: 3 })
      },
      Math.min(SERPER_TIMEOUT_MS, timeoutMs)
    );

    if (!response.ok) {
      console.warn("Serper request failed with HTTP", response.status);
      return "";
    }

    const items = (Array.isArray(data.organic) ? data.organic : [])
      .slice(0, 3)
      .map((item, i) => {
        const title = String(item.title || "").slice(0, 180);
        const snippet = String(item.snippet || "").slice(0, 350);
        const link = String(item.link || "").slice(0, 240);
        return `${i + 1}. ${title}: ${snippet} ${link}`.trim();
      });

    const answerBox = data.answerBox?.answer || data.answerBox?.snippet;
    if (answerBox) items.unshift(`Краткий ответ поисковика: ${String(answerBox).slice(0, 350)}`);
    return items.length ? items.join("\n") : "";
  } catch (error) {
    console.warn("Serper request did not finish in time; continuing without search.");
    return "";
  }
}

async function askGemini(text, history, searchContext, timeoutMs, longTermContext = "") {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("MISSING_GEMINI_KEY");
  if (timeoutMs < 250) throw new Error("TIME_BUDGET_EXHAUSTED");

  const model = String(process.env.GEMINI_MODEL || DEFAULT_MODEL).trim();
  if (!/^[A-Za-z0-9._-]+$/.test(model)) throw new Error("INVALID_MODEL_NAME");

  const contents = safeHistory(history).map(item => ({
    role: item.role,
    parts: [{ text: item.text }]
  }));

  const prompt = searchContext
    ? `${text}\n\nРезультаты поиска в интернете:\n${searchContext}\nИспользуй их только там, где они относятся к вопросу.`
    : text;
  contents.push({ role: "user", parts: [{ text: prompt }] });

  const systemParts = [{ text: SYSTEM_PROMPT }];
  if (longTermContext) systemParts.push({ text: longTermContext });

  const { response, data } = await fetchJson(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": key
      },
      body: JSON.stringify({
        systemInstruction: { parts: systemParts },
        contents,
        generationConfig: {
          temperature: 0.5,
          maxOutputTokens: 240
        }
      })
    },
    Math.min(GEMINI_TIMEOUT_MS, timeoutMs)
  );

  if (!response.ok) {
    const status = Number(response.status);
    console.error("Gemini request failed with HTTP", status);
    if (status === 401 || status === 403) throw new Error("GEMINI_KEY_REJECTED");
    if (status === 429) throw new Error("GEMINI_QUOTA");
    throw new Error("GEMINI_REQUEST_FAILED");
  }

  const candidate = data?.candidates?.[0];
  const answer = (candidate?.content?.parts || [])
    .map(part => typeof part.text === "string" ? part.text : "")
    .join("")
    .trim();

  if (!answer) {
    if (data?.promptFeedback?.blockReason) throw new Error("GEMINI_BLOCKED");
    throw new Error("GEMINI_EMPTY_RESPONSE");
  }
  if (candidate?.finishReason === "MAX_TOKENS") {
    console.warn("Gemini reached the output token limit.");
  }
  return answer;
}

function errorForUser(error) {
  switch (error?.message) {
    case "MISSING_GEMINI_KEY":
      return "Сервер пока не настроен. Проверьте переменную GEMINI_API_KEY в настройках Vercel.";
    case "GEMINI_KEY_REJECTED":
      return "Не удалось подключиться к Gemini. Проверьте API-ключ в настройках Vercel.";
    case "GEMINI_QUOTA":
      return "Сейчас превышен лимит запросов к Gemini. Попробуйте немного позже.";
    case "GEMINI_BLOCKED":
      return "Я не смогла обработать этот запрос. Попробуйте спросить иначе.";
    case "TIME_BUDGET_EXHAUSTED":
    case "AbortError":
      return "Не успела подготовить ответ. Попробуйте задать вопрос ещё раз, чуть короче.";
    default:
      return "Не получилось получить ответ от нейросети. Попробуйте ещё раз чуть позже.";
  }
}

// Opening the webhook URL in a browser answers the question "which code is
// actually live?", which is otherwise guesswork: a fix that sits on an unmerged
// branch never reaches the Vercel production deployment.
function healthReport() {
  return {
    ok: true,
    service: "alice-gemini-serper",
    message: "Webhook is ready. Yandex Dialogs should send POST requests to /api.",
    build: {
      commit: (process.env.VERCEL_GIT_COMMIT_SHA || "unknown").slice(0, 7),
      branch: process.env.VERCEL_GIT_COMMIT_REF || "unknown",
      deployedAt: process.env.VERCEL_DEPLOYMENT_ID ? undefined : "local"
    },
    // If stateHandling is missing from this output, the deployment predates the
    // 1 KB state fix and Yandex will reject responses once storage is enabled.
    stateHandling: {
      byteBudget: STATE_BYTE_BUDGET,
      byteLimit: STATE_BYTE_LIMIT,
      cuts: ["session_state", "application_state", "user_state_update"]
    },
    keys: {
      gemini: Boolean(process.env.GEMINI_API_KEY),
      serper: Boolean(process.env.SERPER_API_KEY),
      model: String(process.env.GEMINI_MODEL || DEFAULT_MODEL)
    }
  };
}

// Every state object that goes back to Yandex is logged with its byte size, so
// the Vercel runtime log shows directly whether the 1 KB limit was the problem.
function logStateSizes(payload, startedAt) {
  const sizes = ["session_state", "application_state", "user_state_update"]
    .filter(key => payload[key] !== undefined)
    .map(key => `${key}=${byteLength(payload[key])}b`);
  const overLimit = ["session_state", "application_state", "user_state_update"]
    .filter(key => payload[key] !== undefined && byteLength(payload[key]) > STATE_BYTE_LIMIT);

  console.log(`[alice] ${Date.now() - startedAt}ms ${sizes.join(" ") || "no state"}`);
  if (overLimit.length) {
    console.error(`[alice] STATE OVER ${STATE_BYTE_LIMIT} B: ${overLimit.join(", ")} — Yandex will reject this response`);
  }
}

async function respond(req, res, startedAt) {
  const reply = payload => {
    logStateSizes(payload, startedAt);
    return res.status(200).json(payload);
  };

  const remainingMs = () => TOTAL_RESPONSE_BUDGET_MS - (Date.now() - startedAt);
  const body = req.body && typeof req.body === "object" ? req.body : {};
  const text = String(body?.request?.command || body?.request?.original_utterance || "").trim();

  const oldHistory = readHistory(body?.state);
  const memory = readMemory(body?.state);
  const isNewSession = body?.session?.new === true;
  // The user cut of the state is only available for Yandex ID accounts.
  const authorized = Boolean(body?.session?.user?.user_id);

  if (!text) {
    return reply(aliceResponse(greetingFor(memory), false, oldHistory, {
      memory: updateMemory(memory, { text: "", isNewSession }),
      authorized
    }));
  }

  if (isForgetIntent(text)) {
    return reply(aliceResponse(
      "Хорошо, я всё забыла. Начнём с чистого листа — о чём поговорим?",
      false,
      [],
      { clearMemory: true, authorized }
    ));
  }

  if (isExitIntent(text)) {
    const farewell = memory.name ? `До встречи, ${memory.name}!` : "До встречи!";
    return reply(aliceResponse(farewell, true, [], {
      memory: updateMemory(memory, { text: "", isNewSession }),
      authorized
    }));
  }

  const nextMemory = updateMemory(memory, { text, isNewSession });

  try {
    let searchContext = "";
    if (isSearchIntent(text) && process.env.SERPER_API_KEY) {
      // Search has a very short budget because Alice expects a response within 4.5 seconds.
      searchContext = await searchWeb(text, Math.min(SERPER_TIMEOUT_MS, Math.max(0, remainingMs() - 2600)));
    }

    const answer = await askGemini(
      text,
      oldHistory,
      searchContext,
      Math.max(0, Math.min(GEMINI_TIMEOUT_MS, remainingMs() - 600)),
      memoryContext(memory)
    );

    const history = [
      ...oldHistory,
      { role: "user", text: text.slice(0, MAX_HISTORY_MESSAGE_CHARS) },
      { role: "model", text: answer.slice(0, MAX_HISTORY_MESSAGE_CHARS) }
    ].slice(-MAX_HISTORY_MESSAGES);

    return reply(aliceResponse(answer, false, history, { memory: nextMemory, authorized }));
  } catch (error) {
    const safeError = error?.message === "AbortError" ? "TIME_BUDGET_EXHAUSTED" : error;
    console.warn("Alice webhook returned a fallback response:", safeError?.message || "unknown error");
    return reply(aliceResponse(errorForUser(safeError), false, oldHistory, {
      memory: nextMemory,
      authorized
    }));
  }
}

export default async function handler(req, res) {
  if (req.method === "GET") {
    return res.status(200).json(healthReport());
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const startedAt = Date.now();
  try {
    return await respond(req, res, startedAt);
  } catch (error) {
    // Anything that escapes respond() would otherwise become an HTTP 500, which
    // Yandex Dialogs shows as a bare server error with no clue what broke. The
    // state readers only receive data once storage is enabled, so this path is
    // exactly where an "it only breaks with storage on" bug would surface.
    console.error("[alice] unhandled error, returning a safe response:", error?.stack || error);
    return res.status(200).json({
      version: "1.0",
      response: {
        text: "Внутренняя ошибка навыка. Посмотрите логи Vercel — там есть подробности.",
        end_session: false
      },
      session_state: { h: [] }
    });
  }
}

export {
  aliceResponse,
  buildSessionState,
  byteLength,
  extractName,
  fitAliceText,
  fitMemory,
  greetingFor,
  isExitIntent,
  isForgetIntent,
  isSearchIntent,
  memoryContext,
  readHistory,
  readMemory,
  safeHistory,
  safeMemory,
  updateMemory,
  STATE_BYTE_LIMIT
};
