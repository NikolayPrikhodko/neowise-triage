import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createApp, extractRequestText } from "../app.mjs";
import { MODEL_TIMEOUT_MS, normalizeModelReply, triage } from "../triage.mjs";

const MANUAL_REVIEW = { status: "manual_review", topic: null, draft: null };

describe("triage: сбои модели дают manual_review", () => {
  test("[error] — модель падает", async () => {
    assert.deepEqual(await triage("Заявка [error]"), MANUAL_REVIEW);
  });

  test("[bad-json] — модель вернула не JSON", async () => {
    assert.deepEqual(await triage("Заявка [bad-json]"), MANUAL_REVIEW);
  });

  test("[bad-topic] — тема вне допустимого списка", async () => {
    assert.deepEqual(await triage("Заявка [bad-topic]"), MANUAL_REVIEW);
  });

  test("[empty-draft] — черновик из одних пробелов", async () => {
    assert.deepEqual(await triage("Заявка [empty-draft]"), MANUAL_REVIEW);
  });

  test("[timeout] — ожидание модели прерывается на 300 мс", async () => {
    const startedAt = Date.now();
    const result = await triage("Заявка [timeout]");
    const elapsed = Date.now() - startedAt;

    assert.deepEqual(result, MANUAL_REVIEW);
    // Имитатор спит 1200 мс; ответ должен прийти заметно раньше.
    assert.ok(elapsed >= MODEL_TIMEOUT_MS - 50, `слишком рано: ${elapsed} мс`);
    assert.ok(elapsed < 1_000, `таймаут не сработал: ${elapsed} мс`);
  });
});

describe("triage: успешный ответ", () => {
  test("обычный текст даёт ready с непустым черновиком", async () => {
    const result = await triage("Здравствуйте, нужен счёт на оплату");

    assert.equal(result.status, "ready");
    assert.equal(result.topic, "other");
    assert.equal(typeof result.draft, "string");
    assert.ok(result.draft.trim().length > 0);
  });

  test("тема delivery распознаётся", async () => {
    const result = await triage("Подскажите сроки доставки");
    assert.equal(result.status, "ready");
    assert.equal(result.topic, "delivery");
  });

  test("тема pricing распознаётся", async () => {
    const result = await triage("Какая цена на услугу?");
    assert.equal(result.status, "ready");
    assert.equal(result.topic, "pricing");
  });
});

describe("normalizeModelReply", () => {
  test("отбрасывает всё, что нельзя показать менеджеру", () => {
    for (const raw of [undefined, null, 42, "", "не json", "null", "[]", '{"topic":"refund","draft":"x"}', '{"topic":"other"}', '{"topic":"other","draft":null}', '{"topic":"other","draft":"   "}']) {
      assert.equal(normalizeModelReply(raw), null, `должно быть отброшено: ${String(raw)}`);
    }
  });

  test("принимает корректный ответ и обрезает пробелы черновика", () => {
    assert.deepEqual(normalizeModelReply('{"topic":"pricing","draft":"  Ответ  "}'), {
      status: "ready",
      topic: "pricing",
      draft: "Ответ",
    });
  });
});

describe("extractRequestText", () => {
  test("отсекает битый и пустой ввод", () => {
    for (const raw of ["", "{", "null", "[]", '"строка"', "{}", '{"text":null}', '{"text":42}', '{"text":["a"]}', '{"text":""}', '{"text":"   "}']) {
      assert.equal(extractRequestText(raw), null, `должно быть отброшено: ${raw}`);
    }
  });

  test("принимает непустой текст", () => {
    assert.equal(extractRequestText('{"text":"  Нужна доставка  "}'), "Нужна доставка");
  });
});

describe("POST /api/triage", () => {
  let server;
  let baseUrl;

  before(async () => {
    server = createServer(createApp({ html: "<!doctype html><title>test</title>" }));
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  async function post(rawBody, contentType = "application/json") {
    const reply = await fetch(`${baseUrl}/api/triage`, {
      method: "POST",
      headers: { "Content-Type": contentType },
      body: rawBody,
    });
    return { status: reply.status, body: await reply.json() };
  }

  test("корректный ввод — 200 ready", async () => {
    const { status, body } = await post(JSON.stringify({ text: "Подскажите сроки доставки" }));

    assert.equal(status, 200);
    assert.equal(body.status, "ready");
    assert.equal(body.topic, "delivery");
    assert.ok(body.draft.trim().length > 0);
  });

  test("сбой модели — 200 manual_review с null-полями", async () => {
    const { status, body } = await post(JSON.stringify({ text: "Заявка [error]" }));

    assert.equal(status, 200);
    assert.deepEqual(body, MANUAL_REVIEW);
  });

  test("таймаут модели — 200 manual_review", async () => {
    const { status, body } = await post(JSON.stringify({ text: "Заявка [timeout]" }));

    assert.equal(status, 200);
    assert.deepEqual(body, MANUAL_REVIEW);
  });

  test("поле text отсутствует — 400 invalid_input", async () => {
    const { status, body } = await post(JSON.stringify({}));

    assert.equal(status, 400);
    assert.deepEqual(body, { status: "invalid_input" });
  });

  test("text не строка — 400 invalid_input", async () => {
    for (const value of [null, 42, true, ["a"], { a: 1 }]) {
      const { status, body } = await post(JSON.stringify({ text: value }));
      assert.equal(status, 400, `для ${JSON.stringify(value)}`);
      assert.deepEqual(body, { status: "invalid_input" });
    }
  });

  test("пустая строка и пробелы — 400 invalid_input", async () => {
    for (const value of ["", "   ", "\n\t"]) {
      const { status, body } = await post(JSON.stringify({ text: value }));
      assert.equal(status, 400, `для ${JSON.stringify(value)}`);
      assert.deepEqual(body, { status: "invalid_input" });
    }
  });

  test("битый JSON — 400 invalid_input", async () => {
    const { status, body } = await post('{"text": "обрыв');

    assert.equal(status, 400);
    assert.deepEqual(body, { status: "invalid_input" });
  });

  test("GET / отдаёт страницу", async () => {
    const reply = await fetch(`${baseUrl}/`);
    assert.equal(reply.status, 200);
    assert.match(reply.headers.get("content-type"), /text\/html/);
  });

  test("неизвестный маршрут — 404", async () => {
    const reply = await fetch(`${baseUrl}/api/unknown`, { method: "POST", body: "{}" });
    assert.equal(reply.status, 404);
  });
});
