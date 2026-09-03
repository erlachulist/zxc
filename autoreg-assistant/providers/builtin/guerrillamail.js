/**
 * AutoReg Assistant — встроенный провайдер GuerrillaMail.
 *
 * Эндпоинты сверены живыми запросами 2026-09-03 против
 * https://www.guerrillamail.com/GuerrillaMailAPI.html:
 *   GET https://api.guerrillamail.com/ajax.php?f=get_email_address&lang=en
 *       → { email_addr, sid_token, ... }
 *   GET .../ajax.php?f=check_email&sid_token=…&seq=0
 *       → { count, list: [{mail_id, mail_from, mail_subject, mail_body,
 *           mail_excerpt, mail_timestamp, ...}] }
 *   GET .../ajax.php?f=fetch_email&sid_token=…&mail_id=…
 *       → { mail_body, ... } (для welcome-письма отдаёт пустое тело —
 *       проверено; поэтому основным источником тела считаем mail_body
 *       уже из списка check_email)
 *
 * Токен самодостаточен: {sid_token, email} в base64 JSON. Сессия живёт
 * ~60 минут без обращений; каждый check_email её продлевает.
 */

import { ProviderError, providerFetch, safeHealthCheck } from "../provider-interface.js";

export const meta = {
  id: "guerrillamail",
  title: "GuerrillaMail",
  domains: [
    "guerrillamail.com",
    "sharklasers.com",
    "grr.la",
    "guerrillamail.net",
    "guerrillamail.org",
    "guerrillamailblock.com",
    "pokemail.net",
    "spam4.me",
  ],
};

const BASE = "https://api.guerrillamail.com/ajax.php";
const SERVICE = "GuerrillaMail";
const TIMEOUT_MS = 15000;

function packToken({ sid, email }) {
  return btoa(JSON.stringify({ s: sid, e: email }));
}

function unpackToken(token) {
  try {
    const data = JSON.parse(atob(String(token)));
    if (data?.s) return { sid: data.s, email: data.e ?? "" };
  } catch {
    /* повреждённый токен обработается ниже */
  }
  throw new ProviderError("provider_unavailable", "Токен GuerrillaMail повреждён — создайте новый email.");
}

/** Создаёт ящик: сервис выдаёт случайный адрес + sid_token сессии. */
export async function createInbox() {
  const data = await providerFetch(`${BASE}?f=get_email_address&lang=en`, {
    timeoutMs: TIMEOUT_MS,
    serviceName: SERVICE,
  });
  if (!data?.email_addr || !data?.sid_token) {
    throw new ProviderError("provider_unavailable", "Неожиданный ответ GuerrillaMail — возможно, формат API изменился.");
  }
  return { email: data.email_addr, token: packToken({ sid: data.sid_token, email: data.email_addr }) };
}

/** Убирает HTML-теги из тела письма. */
function stripTags(html) {
  return String(html ?? "")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Письма ящика: check_email уже возвращает полные тела (mail_body),
 * поэтому fetch_email не нужен в основном пути. seq=0 — все письма.
 */
export async function getMessages(token) {
  const { sid } = unpackToken(token);
  const data = await providerFetch(`${BASE}?f=check_email&sid_token=${encodeURIComponent(sid)}&seq=0`, {
    timeoutMs: TIMEOUT_MS,
    serviceName: SERVICE,
  });

  const messages = (Array.isArray(data?.list) ? data.list : [])
    .filter((m) => m && m.mail_id != null)
    // приветственное письмо самого сервиса не относится к регистрации
    .filter((m) => !(/guerrillamail/i.test(String(m.mail_from ?? "")) && /welcome/i.test(String(m.mail_subject ?? ""))))
    .map((m) => {
      // mail_body у GuerrillaMail — html-разметка; текст для UI/OTP получаем из неё
      const raw = String(m.mail_body ?? "");
      const isHtml = /<[a-z][\s\S]*>/i.test(raw);
      return {
        from: String(m.mail_from ?? ""),
        subject: String(m.mail_subject ?? "(без темы)"),
        body: ((isHtml ? stripTags(raw) : raw) || stripTags(m.mail_excerpt)).slice(0, 20000),
        html: (isHtml ? raw : "").slice(0, 60000),
        receivedAt: Number(m.mail_timestamp) > 0 ? Number(m.mail_timestamp) * 1000 : null,
      };
    });
  return { messages, expired: false };
}

/** Лёгкая проверка живости: get_email_address (создаёт адрес, но это дешёвый запрос). */
export async function healthCheck() {
  return safeHealthCheck(() =>
    providerFetch(`${BASE}?f=get_email_address&lang=en`, { timeoutMs: 8000, serviceName: SERVICE })
  );
}
