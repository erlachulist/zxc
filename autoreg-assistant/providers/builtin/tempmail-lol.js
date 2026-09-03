/**
 * AutoReg Assistant — встроенный провайдер tempmail.lol.
 *
 * Эндпоинты сверены живыми запросами со страницей доков 2026-09-03
 * (https://tempmail.lol/en/api — SPA, контент рендерится на клиенте).
 * Важно: эндпоинты из ранних редакций документации (POST /v2/inbox и
 * GET /v2/auth/{token}) больше не возвращают JSON — API сам отвечает
 * подсказкой «Usage: /v2/inbox?token=token_from_the_create_inbox_endpoint».
 * Актуальные (перепроверено 2026-09-03):
 *   POST https://api.tempmail.lol/v2/inbox/create  → 201 { address, token }
 *   GET  https://api.tempmail.lol/v2/inbox?token=… → 200 { emails: [...], expired }
 *
 * Бесплатный ящик живёт ~1 час, после чего письма перестают приходить
 * (флаг expired в ответе). Ключ API не требуется, но есть общие лимиты запросов (429).
 */

import { ProviderError, providerFetch, safeHealthCheck } from "../provider-interface.js";

export const meta = {
  id: "tempmail-lol",
  title: "tempmail.lol",
  domains: [], // домены выдаёт API динамически (firegameplay.com и др.)
};

const API_BASE = "https://api.tempmail.lol/v2";
const SERVICE = "tempmail.lol";
const TIMEOUT_MS = 15000;

/** Создаёт новый временный ящик. Возвращает { email, token }. */
export async function createInbox() {
  const data = await providerFetch(`${API_BASE}/inbox/create`, {
    method: "POST",
    body: {},
    timeoutMs: TIMEOUT_MS,
    serviceName: SERVICE,
  });
  if (!data?.address || !data?.token) {
    // Формат ответа изменился — честная ошибка вместо падения дальше по цепочке
    throw new ProviderError("provider_unavailable", "Неожиданный ответ tempmail.lol — возможно, формат API изменился.");
  }
  return { email: data.address, token: data.token };
}

/**
 * Возвращает письма ящика: { messages, expired }.
 * html пробрасываем только парсеру (ссылки из href); UI рендерит исключительно текст.
 */
export async function getMessages(token) {
  if (!token) {
    throw new ProviderError("provider_unavailable", "У записи нет токена ящика — проверить почту нельзя.");
  }
  const data = await providerFetch(`${API_BASE}/inbox?token=${encodeURIComponent(token)}`, {
    timeoutMs: TIMEOUT_MS,
    serviceName: SERVICE,
  });

  const messages = (Array.isArray(data?.emails) ? data.emails : []).map((m) => ({
    from: String(m.from ?? ""),
    subject: String(m.subject ?? "(без темы)"),
    // ограничиваем объём: письма нужны для поиска OTP-кодов/ссылок, не для чтения целиком
    body: String(m.body ?? "").slice(0, 20000),
    html: String(m.html ?? "").slice(0, 60000),
    // API отдаёт epoch-дату письма; поле createdAt оставлено как запасное
    receivedAt: Number(m.date ?? m.createdAt ?? 0) || null,
  }));
  return { messages, expired: Boolean(data?.expired) };
}

/**
 * Лёгкая проверка живости: GET /v2/inbox без токена возвращает 200
 * с JSON-подсказкой по использованию (проверено живым запросом).
 * Сетевые ошибки и 5xx → {ok: false}.
 */
export async function healthCheck() {
  return safeHealthCheck(() =>
    providerFetch(`${API_BASE}/inbox`, { timeoutMs: 6000, serviceName: SERVICE })
  );
}
