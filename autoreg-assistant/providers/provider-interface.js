/**
 * AutoReg Assistant — контракт email-провайдера и общий HTTP-хелпер.
 *
 * Каждый провайдер — ES-модуль с экспортами:
 *   meta: { id, title, domains }                   — id, человекочитаемое имя,
 *        список email-доменов (пустой массив = домены выдаёт API динамически);
 *   healthCheck()  → {ok: boolean}                  — лёгкий запрос живости
 *        (используется при failover, фаза 7), не бросает исключений;
 *   createInbox()  → { email, token }               — создать временный ящик;
 *   getMessages(t) → { messages, expired? }         — письма ящика, где
 *        messages: [{ from, subject, body, receivedAt }], expired: boolean.
 *
 * Ошибки провайдеры бросают только ProviderError с errorType из протокола
 * сообщений: network | provider_unavailable | rate_limit | ...
 * Кастомные провайдеры из ar_providers.custom (JSON) приводятся к этому же
 * контракту парсером providers/custom-parser.js (фаза 8).
 */

export class ProviderError extends Error {
  /**
   * @param {string} errorType — тип ошибки из протокола сообщений
   * @param {string} message   — человекочитаемый текст для пользователя
   * @param {object} [options] — { cause } для сохранения исходной ошибки
   */
  constructor(errorType, message, options) {
    super(message, options);
    this.name = "ProviderError";
    this.errorType = errorType;
  }
}

/**
 * fetch с таймаутом и маппингом типовых сбоев на ProviderError.
 * Вызывается только из background service worker — там нет ограничений CORS
 * благодаря host_permissions. Одинаков для всех провайдеров, поэтому живёт здесь.
 *
 * @param {string} url
 * @param {object} [opts]
 *   method, body (объект — сериализуется в JSON), timeoutMs, headers,
 *   serviceName — имя сервиса для текстов ошибок (например, "tempmail.lol"),
 *   okStatuses  — набор статусов, считающихся успехом (по умолчанию 2xx).
 */
export async function providerFetch(
  url,
  { method = "GET", body, timeoutMs = 15000, headers = {}, serviceName = "сервис", okStatuses = null } = {}
) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res;
  try {
    res = await fetch(url, {
      method,
      headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
  } catch (err) {
    if (err?.name === "AbortError") {
      throw new ProviderError(
        "network",
        `${serviceName} не ответил за ${Math.round(timeoutMs / 1000)} с. Проверьте интернет и попробуйте ещё раз.`,
        { cause: err }
      );
    }
    throw new ProviderError("network", `Нет соединения с ${serviceName}. Проверьте интернет и попробуйте ещё раз.`, {
      cause: err,
    });
  } finally {
    clearTimeout(timer);
  }

  const isOk = okStatuses ? okStatuses.includes(res.status) : res.ok;
  // Порядок важен: 429 и 5xx проверяем до разбора тела — оно может быть не-JSON.
  if (res.status === 429) {
    throw new ProviderError("rate_limit", `Лимит запросов к ${serviceName} исчерпан (429). Подождите минуту и попробуйте снова.`);
  }
  if (res.status >= 500) {
    throw new ProviderError("provider_unavailable", `${serviceName} временно недоступен (ошибка ${res.status}). Попробуйте позже.`);
  }

  let data = null;
  try {
    data = await res.json();
  } catch {
    // не-JSON ответ — обработается ниже
  }
  if (!isOk) {
    const serverMsg = data?.error || data?.message || data?.detail;
    const err = new ProviderError("provider_unavailable", serverMsg || `${serviceName} вернул ошибку ${res.status}.`);
    err.status = res.status; // HTTP-код нужен провайдерам для точных ретраев (422 и т.п.)
    throw err;
  }
  return data;
}

/**
 * Обёртка для healthCheck: любая ошибка → {ok: false}, исключений наружу нет.
 * @param {() => Promise<any>} probe — лёгкий запрос провайдера.
 */
export async function safeHealthCheck(probe) {
  try {
    await probe();
    return { ok: true };
  } catch {
    return { ok: false };
  }
}
