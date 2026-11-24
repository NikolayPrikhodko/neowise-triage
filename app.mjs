import { triage } from "./triage.mjs";

const MAX_BODY_BYTES = 64 * 1024;

export const INVALID_INPUT = Object.freeze({ status: "invalid_input" });

function sendJson(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error("body_too_large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Достаёт текст заявки из сырого тела запроса.
 * Возвращает null для битого JSON, не-объекта, отсутствующего/нестрокового
 * поля text и строки из одних пробелов.
 */
export function extractRequestText(rawBody) {
  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return null;
  }

  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return null;

  const { text } = payload;
  if (typeof text !== "string") return null;

  const trimmed = text.trim();
  return trimmed === "" ? null : trimmed;
}

async function handleTriage(request, response) {
  let rawBody;
  try {
    rawBody = await readBody(request);
  } catch {
    return sendJson(response, 400, INVALID_INPUT);
  }

  const text = extractRequestText(rawBody);
  if (text === null) return sendJson(response, 400, INVALID_INPUT);

  const result = await triage(text);
  return sendJson(response, 200, result);
}

export function createApp({ html }) {
  return async function handleRequest(request, response) {
    if (request.method === "GET" && request.url === "/") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(html);
      return;
    }

    if (request.method === "POST" && request.url === "/api/triage") {
      try {
        await handleTriage(request, response);
      } catch {
        if (!response.headersSent) sendJson(response, 500, { status: "server_error" });
        else response.end();
      }
      return;
    }

    sendJson(response, 404, { status: "not_found" });
  };
}
