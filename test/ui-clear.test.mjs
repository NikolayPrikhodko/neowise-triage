import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

// Тест гоняет настоящий скрипт со страницы: берём его из index.html,
// а не переписываем логику в тесте. DOM подменяем минимальной заглушкой,
// поэтому тест не тянет jsdom и не требует сети.
const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
const scriptMatch = html.match(/<script type="module">([\s\S]*?)<\/script>/);
if (!scriptMatch) throw new Error("В index.html не найден inline-скрипт страницы");
const pageScript = scriptMatch[1];

function createElement(name) {
  return {
    name,
    value: "",
    textContent: "",
    className: "",
    hidden: false,
    disabled: false,
    listener: null,
    addEventListener(type, handler) {
      if (type === "submit") this.listener = handler;
    },
  };
}

/**
 * Загружает страницу с подставным fetch.
 * responses — очередь ответов: объект (тело JSON) или Error (сетевой сбой).
 */
function loadPage(responses) {
  const elements = {
    form: createElement("form"),
    "#message": createElement("#message"),
    "button[type=submit]": createElement("button[type=submit]"),
    "#status": createElement("#status"),
    "#result": createElement("#result"),
    "#topic": createElement("#topic"),
    "#draft": createElement("#draft"),
  };

  const requests = [];
  let cursor = 0;

  const fetchStub = async (url, options = {}) => {
    requests.push({ url, body: options.body });
    const next = responses[Math.min(cursor, responses.length - 1)];
    cursor += 1;
    if (next instanceof Error) throw next;
    return { json: async () => next };
  };

  const documentStub = { querySelector: (selector) => elements[selector] ?? null };

  vm.runInNewContext(pageScript, { document: documentStub, fetch: fetchStub, console });

  async function submit(text) {
    elements["#message"].value = text;
    await elements.form.listener({ preventDefault() {} });
  }

  return { elements, requests, submit };
}

const READY = { status: "ready", topic: "delivery", draft: "Спасибо за обращение. Уточним детали заявки." };
const MANUAL = { status: "manual_review", topic: null, draft: null };

describe("Страница: очистка предыдущего черновика", () => {
  test("успех показывает тему и черновик", async () => {
    const page = loadPage([READY]);
    await page.submit("Сколько идёт доставка?");

    assert.equal(page.elements["#draft"].value, READY.draft);
    assert.equal(page.elements["#topic"].textContent, "Доставка");
    assert.equal(page.elements["#result"].hidden, false);
    assert.equal(page.elements["#status"].hidden, true);
  });

  test("manual_review очищает черновик и скрывает блок результата", async () => {
    const page = loadPage([READY, MANUAL]);

    await page.submit("Нормальная заявка");
    assert.notEqual(page.elements["#draft"].value, "", "перед сбоем черновик должен быть показан");

    await page.submit("Заявка [error]");

    assert.equal(page.elements["#draft"].value, "", "черновик должен быть очищен");
    assert.equal(page.elements["#topic"].textContent, "", "тема должна быть очищена");
    assert.equal(page.elements["#result"].hidden, true, "блок результата должен быть скрыт");
    assert.equal(page.elements["#status"].hidden, false);
    assert.match(page.elements["#status"].textContent, /вручную/);
  });

  test("сетевой сбой очищает черновик", async () => {
    const page = loadPage([READY, new Error("network down")]);

    await page.submit("Нормальная заявка");
    assert.notEqual(page.elements["#draft"].value, "");

    await page.submit("Заявка в офлайне");

    assert.equal(page.elements["#draft"].value, "");
    assert.equal(page.elements["#result"].hidden, true);
    assert.equal(page.elements["#status"].hidden, false);
  });

  test("invalid_input очищает черновик", async () => {
    const page = loadPage([READY, { status: "invalid_input" }]);

    await page.submit("Нормальная заявка");
    assert.notEqual(page.elements["#draft"].value, "");

    await page.submit("Заявка без тела");

    assert.equal(page.elements["#draft"].value, "");
    assert.equal(page.elements["#result"].hidden, true);
  });

  test("пустой ввод очищает черновик и не ходит в сеть", async () => {
    const page = loadPage([READY]);

    await page.submit("Нормальная заявка");
    assert.notEqual(page.elements["#draft"].value, "");
    const requestsBefore = page.requests.length;

    await page.submit("   ");

    assert.equal(page.elements["#draft"].value, "");
    assert.equal(page.elements["#result"].hidden, true);
    assert.equal(page.requests.length, requestsBefore, "запрос к API не должен уходить");
    assert.match(page.elements["#status"].textContent, /не должно быть пустым/);
  });
});
