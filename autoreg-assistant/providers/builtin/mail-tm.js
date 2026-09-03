/**
 * AutoReg Assistant — встроенный провайдер mail.tm.
 *
 * Эндпоинты сверены живыми запросами 2026-09-03 (создан реальный аккаунт):
 *   GET  https://api.mail.tm/domains        → { "hydra:member": [{domain, isActive, isPrivate}] }
 *   POST https://api.mail.tm/accounts       → 201 { id, address, ... }  (тело: {address, password})
 *   POST https://api.mail.tm/token          → { token: <JWT> }          (тело: {address, password})
 *   GET  https://api.mail.tm/messages?page=1 (Authorization: Bearer JWT) → { "hydra:member": [...] }
 *   GET  https://api.mail.tm/messages/{id}  → { subject, text, html, from, ... }
 *
 * Токен самодостаточен: в него упакованы JWT + логин/пароль аккаунта
 * (base64 JSON), чтобы при протухании JWT перелогиниться без состояния.
 * Лимиты mail.tm: ~8 запросов/сек (429 обрабатывается общим хелпером).
 */

import { ProviderError, providerFetch, safeHealthCheck } from "../provider-interface.js";

export const meta = {
  id: "mail-tm",
  title: "mail.tm",
  domains: [], // список доменов меняется — получаем из GET /domains
};

const BASE = "https://api.mail.tm";
const SERVICE = "mail.tm";
const TIMEOUT_MS = 15000;

/** Упаковка учётных данных в непрозрачный токен записи. */
function packToken({ jwt, address, password }) {
  return btoa(JSON.stringify({ j: jwt, a: address, p: password }));
}

function unpackToken(token) {
  try {
    const data = JSON.parse(atob(String(token)));
    if (data?.j && data?.a && data?.p) return { jwt: data.j, address: data.a, password: data.p };
  } catch {
    /* повреждённый токен обработается ниже */
  }
  throw new ProviderError("provider_unavailable", "Токен mail.tm повреждён — создайте новый email.");
}

/** Случайная локальная часть: word-word-digits (некоторые сайты не любят чистый хекс). */
function randomLocalPart() {
  const words = ["amber", "nova", "quark", "river", "solar", "tiger", "violet", "willow", "orbit", "pixel"];
  const pick = () => words[Math.floor(Math.random() * words.length)];
  const digits = Math.floor(Math.random() * 900 + 100);
  return `${pick()}.${pick()}${digits}`;
}

/** POST /token — JWT по логину/паролу. */
async function login(address, password) {
  const data = await providerFetch(`${BASE}/token`, {
    method: "POST",
    body: { address, password },
    timeoutMs: TIMEOUT_MS,
    serviceName: SERVICE,
  });
  if (!data?.token) throw new ProviderError("provider_unavailable", "mail.tm не выдал токен доступа.");
  return data.token;
}

/** Создаёт аккаунт mail.tm: домен → адрес + пароль → аккаунт → JWT. */
export async function createInbox() {
  // Домены: только активные и публичные
  const domainsData = await providerFetch(`${BASE}/domains`, { timeoutMs: TIMEOUT_MS, serviceName: SERVICE });
  const domains = (domainsData?.["hydra:member"] ?? domainsData ?? [])
    .filter((d) => d.isActive !== false && d.isPrivate !== true && d.domain)
    .map((d) => d.domain);
  if (domains.length === 0) {
    throw new ProviderError("provider_unavailable", "mail.tm сейчас не отдаёт доступные домены.");
  }
  const domain = domains[Math.floor(Math.random() * domains.length)];

  // Пароль аккаунта mail.tm: нужен для перелогина при протухшем JWT
  const password = `Ar!${Math.random().toString(36).slice(2, 10)}${Math.random().toString(36).slice(2, 8).toUpperCase()}9`;

  // До 3 попыток: адрес может оказаться занят (HTTP 422 — валидация mail.tm)
  let address = null;
  for (let i = 0; i < 3 && !address; i++) {
    const candidate = `${randomLocalPart()}@${domain}`;
    try {
      const acc = await providerFetch(`${BASE}/accounts`, {
        method: "POST",
        body: { address: candidate, password },
        timeoutMs: TIMEOUT_MS,
        serviceName: SERVICE,
      });
      address = acc?.address ?? candidate;
    } catch (err) {
      if (err?.status !== 422) throw err; // 422 — занят/невалиден, пробуем другой адрес
    }
  }
  if (!address) {
    throw new ProviderError("provider_unavailable", "mail.tm не смог создать ящик (варианты адреса заняты).");
  }

  const jwt = await login(address, password);
  return { email: address, token: packToken({ jwt, address, password }) };
}

/** GET /messages (+ перелогин при протухшем JWT) — список писем. */
async function fetchMessageList(auth) {
  const tryFetch = (jwt) =>
    providerFetch(`${BASE}/messages?page=1`, {
      headers: { Authorization: `Bearer ${jwt}` },
      timeoutMs: TIMEOUT_MS,
      serviceName: SERVICE,
    });

  let data;
  try {
    data = await tryFetch(auth.jwt);
  } catch (err) {
    // 401 — JWT протух: перелогиниваемся и повторяем один раз
    if (err?.status === 401) {
      const freshJwt = await login(auth.address, auth.password);
      data = await tryFetch(freshJwt);
    } else {
      throw err;
    }
  }
  return data?.["hydra:member"] ?? [];
}

/** Убирает HTML-теги (письма без text-поля приходят только в html). */
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
 * Письма ящика. Тела получаем списком (intro) + догружаем полные тексты
 * первых 10 писем поштучно — экономим запросы (лимит mail.tm 8 QPS).
 */
export async function getMessages(token) {
  const auth = unpackToken(token);
  const list = await fetchMessageList(auth);

  const messages = [];
  for (const item of list.slice(0, 10)) {
    let body = String(item.intro ?? "");
    let html = "";
    try {
      const full = await providerFetch(`${BASE}/messages/${item.id}`, {
        headers: { Authorization: `Bearer ${auth.jwt}` },
        timeoutMs: TIMEOUT_MS,
        serviceName: SERVICE,
      });
      // html приходит массивом частей либо строкой; отдаём парсеру как есть (ссылки в href)
      html = Array.isArray(full?.html) ? full.html.join("\n") : String(full?.html ?? "");
      body = String(full?.text ?? "") || stripTags(html) || body;
    } catch {
      // недогрузили полное тело — остаёмся на intro
    }
    messages.push({
      from: String(item?.from?.address ?? ""),
      subject: String(item.subject ?? "(без темы)"),
      body: body.slice(0, 20000),
      html: html.slice(0, 60000),
      receivedAt: item.createdAt ? Date.parse(item.createdAt) || null : null,
    });
  }
  return { messages, expired: false };
}

/** Лёгкая проверка живости: GET /domains. */
export async function healthCheck() {
  return safeHealthCheck(() => providerFetch(`${BASE}/domains`, { timeoutMs: 6000, serviceName: SERVICE }));
}
