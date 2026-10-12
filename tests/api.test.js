import test from "node:test";
import assert from "node:assert/strict";
import {
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
} from "../api/index.js";

function callHandler(req) {
  return (async () => {
    const handler = (await import("../api/index.js")).default;
    let statusCode = 200;
    let payload;
    const res = {
      status(code) { statusCode = code; return this; },
      json(value) { payload = value; return value; },
      setHeader() {}
    };
    await handler(req, res);
    return { statusCode, payload };
  })();
}

const longRussianTurn = "Расскажи подробно про погоду в Москве на этой неделе и что лучше надеть вечером";

test("Alice response uses required response envelope", () => {
  const result = aliceResponse("Привет", false, [{ role: "user", text: "тест" }]);
  assert.equal(result.version, "1.0");
  assert.equal(result.response.text, "Привет");
  assert.equal(result.response.end_session, false);
  assert.deepEqual(result.session_state.h, [{ r: "u", t: "тест" }]);
});

test("search intent detects Russian and English freshness requests", () => {
  assert.equal(isSearchIntent("Какая погода сегодня?"), true);
  assert.equal(isSearchIntent("What is the latest news?"), true);
  assert.equal(isSearchIntent("Расскажи сказку"), false);
});

test("long responses are cut at a natural boundary and stay within Alice limit", () => {
  const value = fitAliceText(("Это короткое предложение. ").repeat(100));
  assert.ok(value.length <= 1024);
  assert.ok(value.endsWith("."));
});

test("history filters malformed messages and keeps last 8", () => {
  const input = Array.from({ length: 12 }, (_, i) => ({ role: i % 2 ? "model" : "user", text: String(i) }));
  input.push({ role: "hacker", text: "ignore" }, { role: "user", text: 17 });
  const result = safeHistory(input);
  assert.equal(result.length, 8);
  assert.equal(result[0].text, "4");
  assert.equal(result[7].text, "11");
});

// --- Yandex 1 KB state limit --------------------------------------------------

test("session state stays under the 1 KB Yandex limit even with a long history", () => {
  const history = Array.from({ length: 8 }, (_, i) => ({
    role: i % 2 ? "model" : "user",
    text: longRussianTurn.repeat(20).slice(0, 1200)
  }));
  const state = buildSessionState(history);
  assert.ok(byteLength(state) <= STATE_BYTE_LIMIT, `state was ${byteLength(state)} bytes`);
  assert.ok(state.h.length >= 1, "at least the newest turn must survive");
});

test("session state keeps the newest turns when the budget runs out", () => {
  const history = Array.from({ length: 8 }, (_, i) => ({
    role: i % 2 ? "model" : "user",
    text: `сообщение номер ${i} ${longRussianTurn}`
  }));
  const state = buildSessionState(history);
  const last = state.h[state.h.length - 1];
  assert.match(last.t, /сообщение номер 7/);
  assert.equal(last.r, "m");
});

test("full Alice response payload fits every state object under the limit", () => {
  const history = Array.from({ length: 8 }, (_, i) => ({
    role: i % 2 ? "model" : "user",
    text: longRussianTurn.repeat(20).slice(0, 1200)
  }));
  const memory = updateMemory(
    { v: 1, name: "Никита", n: 40, topics: [longRussianTurn, longRussianTurn, longRussianTurn] },
    { text: longRussianTurn, isNewSession: true }
  );
  const payload = aliceResponse("Ответ", false, history, { memory, authorized: true });

  for (const key of ["session_state", "application_state", "user_state_update"]) {
    assert.ok(payload[key], `${key} is missing`);
    assert.ok(byteLength(payload[key]) <= STATE_BYTE_LIMIT, `${key} was ${byteLength(payload[key])} bytes`);
  }
});

test("oversized memory is shrunk rather than returned over the limit", () => {
  const fitted = fitMemory({ v: 1, name: "Никита", n: 3, seen: "2026-10-12", topics: ["а".repeat(400), "б".repeat(400), "в".repeat(400)] });
  assert.ok(byteLength(fitted) <= STATE_BYTE_LIMIT);
});

test("session state is omitted when the session ends", () => {
  const payload = aliceResponse("До встречи!", true, [{ role: "user", text: "пока" }]);
  assert.equal(payload.session_state, undefined);
  assert.equal(payload.response.end_session, true);
});

// --- Reading incoming state ---------------------------------------------------

test("incoming session state is read in both the new and the legacy shape", () => {
  assert.deepEqual(readHistory({ session: { h: [{ r: "u", t: "привет" }] } }), [{ role: "user", text: "привет" }]);
  assert.deepEqual(readHistory({ session: { history: [{ role: "model", text: "ответ" }] } }), [{ role: "model", text: "ответ" }]);
  assert.deepEqual(readHistory(undefined), []);
  assert.deepEqual(readHistory({ session: "broken" }), []);
});

test("memory is sanitised and merged across the application and user cuts", () => {
  const memory = readMemory({
    application: { v: 1, name: "Аноним", n: 2, seen: "2026-01-01", topics: ["погода", "погода"] },
    user: { v: 1, name: "Никита", n: 7, seen: "2026-10-12", topics: ["космос"] }
  });
  assert.equal(memory.name, "Никита");
  assert.equal(memory.n, 7);
  assert.equal(memory.seen, "2026-10-12");
  assert.deepEqual(memory.topics, ["космос", "погода"]);
});

test("malformed stored memory is dropped instead of trusted", () => {
  const memory = safeMemory({ name: 42, n: "много", seen: "вчера", topics: "погода" });
  assert.deepEqual(memory, { v: 1 });
  assert.deepEqual(safeMemory(null), { v: 1 });
});

// --- Long-term memory behaviour ----------------------------------------------

test("a name is captured from natural phrasing only", () => {
  assert.equal(extractName("Меня зовут Никита"), "Никита");
  assert.equal(extractName("моё имя Анна"), "Анна");
  assert.equal(extractName("зови меня Макс"), "Макс");
  assert.equal(extractName("Какая сегодня погода?"), "");
  assert.equal(extractName("зови меня пожалуйста"), "");
});

test("visit counter only advances on a new session", () => {
  const first = updateMemory({ v: 1 }, { text: "привет", isNewSession: true });
  assert.equal(first.n, 1);
  const sameSession = updateMemory(first, { text: "ещё вопрос", isNewSession: false });
  assert.equal(sameSession.n, 1);
  const secondSession = updateMemory(sameSession, { text: "привет", isNewSession: true });
  assert.equal(secondSession.n, 2);
});

test("filler turns do not take a remembered topic slot", () => {
  let memory = updateMemory({ v: 1 }, { text: "расскажи про чёрные дыры", isNewSession: true });
  for (const text of ["да", "ещё", "спасибо", "ага"]) {
    memory = updateMemory(memory, { text, isNewSession: false });
  }
  assert.deepEqual(memory.topics, ["расскажи про чёрные дыры"]);
});

test("recent topics are deduplicated and capped at three", () => {
  let memory = { v: 1 };
  for (const text of ["погода", "космос", "погода", "курс валют", "новости"]) {
    memory = updateMemory(memory, { text, isNewSession: false });
  }
  assert.deepEqual(memory.topics, ["новости", "курс валют", "погода"]);
});

test("memory is turned into prompt context only when something is remembered", () => {
  assert.equal(memoryContext({ v: 1 }), "");
  const context = memoryContext({ v: 1, name: "Никита", n: 3, topics: ["погода"] });
  assert.match(context, /Никита/);
  assert.match(context, /разговор номер 3/);
  assert.match(context, /погода/);
});

test("greeting is personalised from long-term memory", () => {
  assert.match(greetingFor({ v: 1, name: "Никита" }), /С возвращением, Никита/);
  assert.match(greetingFor({ v: 1, n: 4, topics: ["погода"] }), /В прошлый раз мы говорили про погода/);
  assert.match(greetingFor({ v: 1 }), /Привет/);
});

test("exit and forget intents are recognised", () => {
  assert.equal(isExitIntent("хватит"), true);
  assert.equal(isExitIntent("до свидания"), true);
  assert.equal(isExitIntent("спасибо, хватит"), true);
  assert.equal(isExitIntent("хватит, спасибо"), true);
  assert.equal(isExitIntent("пока"), true);
  assert.equal(isExitIntent("расскажи, когда хватит сил"), false);
  assert.equal(isExitIntent("пока что расскажи про космос"), false);
  assert.equal(isExitIntent("спасибо"), false);
  assert.equal(isForgetIntent("забудь всё"), true);
  assert.equal(isForgetIntent("очисти память"), true);
  assert.equal(isForgetIntent("расскажи про память человека"), false);
});

// --- Handler ------------------------------------------------------------------

test("GET health check returns an ok response", async () => {
  const { statusCode, payload } = await callHandler({ method: "GET" });
  assert.equal(statusCode, 200);
  assert.equal(payload.ok, true);
  assert.equal(payload.service, "alice-gemini-serper");
});

test("GET health check reports the build and the state limits it enforces", async () => {
  const { payload } = await callHandler({ method: "GET" });
  // Absence of this block is how you tell a deployment predates the 1 KB fix.
  assert.equal(payload.stateHandling.byteLimit, STATE_BYTE_LIMIT);
  assert.ok(payload.stateHandling.byteBudget < STATE_BYTE_LIMIT);
  assert.deepEqual(payload.stateHandling.cuts, ["session_state", "application_state", "user_state_update"]);
  assert.ok(payload.build, "build info is missing");
  assert.equal(typeof payload.keys.gemini, "boolean");
});

test("an unexpected failure returns a valid Alice response instead of HTTP 500", async () => {
  const body = { request: { command: "привет" }, session: { new: true } };
  // Yandex reports any 500 as a bare server error, so nothing may escape.
  Object.defineProperty(body, "state", { get() { throw new Error("boom in state"); } });

  const { statusCode, payload } = await callHandler({ method: "POST", body });
  assert.equal(statusCode, 200);
  assert.equal(payload.version, "1.0");
  assert.equal(payload.response.end_session, false);
  assert.ok(payload.response.text.length > 0);
  assert.ok(byteLength(payload.session_state) <= STATE_BYTE_LIMIT);
});

test("launch request returns a valid Alice greeting without external API keys", async () => {
  const { statusCode, payload } = await callHandler({
    method: "POST",
    body: { request: { command: "" }, session: { new: true }, state: { session: { h: [] } } }
  });
  assert.equal(statusCode, 200);
  assert.equal(payload.version, "1.0");
  assert.match(payload.response.text, /Привет/);
  assert.equal(payload.response.end_session, false);
  assert.equal(payload.application_state.n, 1);
  assert.equal(payload.user_state_update, undefined, "an unauthorised user has no user state");
});

test("launch request greets a returning, signed-in user by name", async () => {
  const { payload } = await callHandler({
    method: "POST",
    body: {
      request: { command: "" },
      session: { new: true, user: { user_id: "abc" } },
      state: { user: { v: 1, name: "Никита", n: 5, topics: ["погода"] } }
    }
  });
  assert.match(payload.response.text, /С возвращением, Никита/);
  assert.equal(payload.user_state_update.n, 6);
  assert.equal(payload.user_state_update.name, "Никита");
});

test("forget request clears both persistent state cuts", async () => {
  const { payload } = await callHandler({
    method: "POST",
    body: {
      request: { command: "забудь всё" },
      session: { new: false, user: { user_id: "abc" } },
      state: { application: { v: 1, name: "Никита" }, user: { v: 1, name: "Никита" } }
    }
  });
  assert.deepEqual(payload.application_state, {});
  assert.equal(payload.user_state_update.name, null);
  assert.deepEqual(payload.session_state, { h: [] });
});

test("exit request ends the session and keeps persistent memory", async () => {
  const { payload } = await callHandler({
    method: "POST",
    body: {
      request: { command: "хватит" },
      session: { new: false, user: { user_id: "abc" } },
      state: { user: { v: 1, name: "Никита", n: 2 } }
    }
  });
  assert.equal(payload.response.end_session, true);
  assert.match(payload.response.text, /До встречи, Никита/);
  assert.equal(payload.session_state, undefined);
  assert.equal(payload.user_state_update.name, "Никита");
});

test("a failing Gemini call still returns a valid, state-safe response", async () => {
  const previousKey = process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  try {
    const { statusCode, payload } = await callHandler({
      method: "POST",
      body: {
        request: { command: "Расскажи анекдот" },
        session: { new: true },
        state: { session: { h: [{ r: "u", t: longRussianTurn }] } }
      }
    });
    assert.equal(statusCode, 200);
    assert.equal(payload.version, "1.0");
    assert.match(payload.response.text, /GEMINI_API_KEY/);
    assert.ok(byteLength(payload.session_state) <= STATE_BYTE_LIMIT);
    assert.ok(byteLength(payload.application_state) <= STATE_BYTE_LIMIT);
  } finally {
    if (previousKey !== undefined) process.env.GEMINI_API_KEY = previousKey;
  }
});

test("POST with a non-object body does not crash the webhook", async () => {
  const { statusCode, payload } = await callHandler({ method: "POST", body: "not json" });
  assert.equal(statusCode, 200);
  assert.equal(payload.version, "1.0");
  assert.ok(payload.response.text.length > 0);
});
