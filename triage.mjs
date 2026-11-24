import { classify } from "./mock-ai.mjs";

export const MODEL_TIMEOUT_MS = 300;
export const ALLOWED_TOPICS = Object.freeze(["delivery", "pricing", "other"]);

function manualReview() {
  return { status: "manual_review", topic: null, draft: null };
}

/**
 * Проверяет ответ модели и превращает его в готовый результат триажа.
 * Возвращает null, если ответ нельзя показать менеджеру как есть:
 * не строка, не JSON, тема вне списка, черновик пустой или не строка.
 */
export function normalizeModelReply(raw) {
  if (typeof raw !== "string") return null;

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return null;
  }

  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return null;

  const { topic, draft } = payload;
  if (typeof topic !== "string" || !ALLOWED_TOPICS.includes(topic)) return null;
  if (typeof draft !== "string") return null;

  const trimmedDraft = draft.trim();
  if (trimmedDraft === "") return null;

  return { status: "ready", topic, draft: trimmedDraft };
}

/**
 * Разбирает одну заявку. Никогда не бросает: любая проблема с моделью
 * (таймаут, исключение, негодный ответ) даёт manual_review.
 */
export async function triage(text) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MODEL_TIMEOUT_MS);

  try {
    const raw = await classify(text, { signal: controller.signal });
    return normalizeModelReply(raw) ?? manualReview();
  } catch {
    return manualReview();
  } finally {
    clearTimeout(timer);
  }
}
