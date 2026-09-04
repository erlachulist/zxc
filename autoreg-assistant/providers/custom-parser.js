/**
 * AutoReg Assistant — кастомные провайдеры через JSON (фаза 8).
 *
 * Формат конфига (полный пример):
 * {
 *   "name": "MyProvider",
 *   "apiKey": "secret",                        // необязательно; подставляется в {{apiKey}}
 *   "domains": ["example.com"],                // необязательно
 *   "createInbox": {
 *     "method": "POST",
 *     "url": "https://api.example.com/inbox",
 *     "headers": {"Authorization": "Bearer {{apiKey}}"},
 *     "body": {"ttl": 3600},                   // необязательно
 *     "responseMapping": {"email": "data.address", "token": "data.token"}
 *   },
 *   "getMessages": {
 *     "method": "GET",
 *     "url": "https://api.example.com/inbox/{{token}}",
 *     "responseMapping": {
 *       "messages": "data.emails",
 *       "from": "sender", "subject": "title",  // пути ОТНОСИТЕЛЬНО элемента, опционально
 *       "body": "text", "receivedAt": "date"
 *     }
 *   }
 * }
 *
 * Правила: dot-notation ("data.address", "list.0.email"), подстановки
 * {{token}}/{{apiKey}} в URL и headers, только https-адреса (ограничение
 * host_permissions расширения).
 */

import { ProviderError, providerFetch } from "./provider-interface.js";

// ---------------------------------------------------------------------------
// Хелперы маппинга
// ---------------------------------------------------------------------------

/** Значение по dot-пути: getPath({data:{list:[{a:1}]}}, "data.list.0.a") → 1. */
export function getPath(obj, path) {
  if (obj == null || !path) return undefined;
  let cur = obj;
  for (const key of String(path).split(".")) {
    if (cur == null) return undefined;
    if (Array.isArray(cur)) {
      const idx = Number(key);
      if (!Number.isInteger(idx) || idx < 0 || idx >= cur.length) return undefined;
      cur = cur[idx];
    } else if (typeof cur === "object") {
      // Только собственные ключи: путь из чужого JSON не должен ходить по прототипу
      cur = Object.prototype.hasOwnProperty.call(cur, key) ? cur[key] : undefined;
    } else {
      return undefined;
    }
  }
  return cur;
}

/** Подстановка {{apiKey}} / {{token}} в строку (url, header-значения). */
export function substitute(template, vars) {
  return String(template ?? "").replace(/\{\{\s*(\w+)\s*\}\}/g, (all, key) => {
    const value = vars?.[key];
    return value === undefined || value === null ? "" : String(value);
  });
}

/** id кастомного провайдера: "custom:" + slug имени. */
export function customProviderId(name) {
  const slug = String(name ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return `custom:${slug || "provider"}`;
}

// ---------------------------------------------------------------------------
// Валидация
// ---------------------------------------------------------------------------

/**
 * Проверяет конфиг кастомного провайдера.
 * @returns {{ok: boolean, errors: string[]}} — ошибки с указанием поля.
 */
export function validateConfig(cfg) {
  const errors = [];
  const fail = (field, msg) => errors.push(`${field}: ${msg}`);

  if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) {
    return { ok: false, errors: ["Конфиг должен быть JSON-объектом {…}"] };
  }
  if (typeof cfg.name !== "string" || !cfg.name.trim()) fail("name", "укажите непустое имя провайдера");

  for (const section of ["createInbox", "getMessages"]) {
    const part = cfg[section];
    if (!part || typeof part !== "object" || Array.isArray(part)) {
      fail(section, "обязательный объект с method, url и responseMapping");
      continue;
    }
    if (!["GET", "POST", "PUT", "PATCH"].includes(String(part.method ?? "").toUpperCase())) {
      fail(`${section}.method`, "укажите GET или POST");
    }
    if (typeof part.url !== "string" || !/^https:\/\//i.test(part.url.trim())) {
      fail(`${section}.url`, "нужен абсолютный https:// адрес (http не поддерживается host_permissions)");
    }
    if (!part.responseMapping || typeof part.responseMapping !== "object") {
      fail(`${section}.responseMapping`, "обязателен объект маппинга полей ответа");
    }
  }

  if (cfg.createInbox?.responseMapping) {
    const rm = cfg.createInbox.responseMapping;
    if (typeof rm.email !== "string" || !rm.email.trim()) {
      fail("createInbox.responseMapping.email", "укажите dot-путь к адресу (например, \"data.address\")");
    }
    if (rm.token !== undefined && typeof rm.token !== "string") {
      fail("createInbox.responseMapping.token", "должен быть строкой-dot-путём");
    }
  }
  if (cfg.getMessages?.responseMapping) {
    const rm = cfg.getMessages.responseMapping;
    if (typeof rm.messages !== "string" || !rm.messages.trim()) {
      fail("getMessages.responseMapping.messages", "укажите dot-путь к массиву писем (например, \"data.emails\")");
    }
  }
  if (cfg.domains !== undefined && !(Array.isArray(cfg.domains) && cfg.domains.every((d) => typeof d === "string" && d.includes(".")))) {
    fail("domains", "массив строк-доменов (например, [\"example.com\"])");
  }
  if (cfg.apiKey !== undefined && typeof cfg.apiKey !== "string") {
    fail("apiKey", "строка-секрет для подстановки {{apiKey}}");
  }

  return { ok: errors.length === 0, errors };
}

/** Парсит текст JSON → конфиг, с валидацией. Ошибки — на русском, с указанием поля. */
export function parseConfig(jsonText) {
  let cfg;
  try {
    cfg = JSON.parse(String(jsonText));
  } catch (err) {
    return { ok: false, errors: [`JSON не разбирается: ${err.message}`] };
  }
  const { ok, errors } = validateConfig(cfg);
  if (!ok) return { ok: false, errors };
  return { ok: true, config: { ...cfg, id: customProviderId(cfg.name), enabled: cfg.enabled !== false } };
}

// ---------------------------------------------------------------------------
// Создание провайдера из конфига
// ---------------------------------------------------------------------------

/** Поля письма по умолчанию: пробуем стандартные имена, если пути не заданы. */
const MESSAGE_FIELD_FALLBACKS = {
  from: ["from", "sender", "fromAddress", "from_address"],
  subject: ["subject", "title"],
  body: ["body", "text", "message", "content"],
  html: ["html", "htmlBody", "html_body"],
  receivedAt: ["receivedAt", "date", "timestamp", "createdAt", "time"],
};

/**
 * Создаёт провайдер (контракт как у встроенных) из валидного конфига.
 * @param {object} cfg — конфиг после parseConfig (с id/enabled).
 */
export function createCustomProvider(cfg) {
  const { ok, errors } = validateConfig(cfg);
  if (!ok) {
    throw new ProviderError("provider_unavailable", `Неверный конфиг провайдера: ${errors.join("; ")}`);
  }
  const serviceName = cfg.name;
  const apiKey = () => cfg.apiKey ?? "";

  const buildRequest = (section, vars) => {
    const headers = {};
    for (const [k, v] of Object.entries(section.headers ?? {})) {
      headers[k] = substitute(v, { apiKey: apiKey() });
    }
    return {
      url: substitute(section.url, { ...vars, apiKey: apiKey() }),
      method: String(section.method ?? "GET").toUpperCase(),
      headers,
      body: section.body !== undefined ? JSON.parse(JSON.stringify(section.body)) : undefined,
    };
  };

  return {
    meta: {
      id: cfg.id ?? customProviderId(cfg.name),
      title: cfg.name,
      domains: Array.isArray(cfg.domains) ? cfg.domains : [],
    },

    async createInbox() {
      const req = buildRequest(cfg.createInbox, {});
      const data = await providerFetch(req.url, {
        method: req.method,
        body: req.body !== undefined ? req.body : req.method === "POST" ? {} : undefined,
        headers: req.headers,
        serviceName,
      });
      const rm = cfg.createInbox.responseMapping;
      const email = getPath(data, rm.email);
      const token = rm.token ? String(getPath(data, rm.token) ?? "") : "";
      if (!email || typeof email !== "string") {
        throw new ProviderError(
          "provider_unavailable",
          `Маппинг responseMapping.email («${rm.email}») не нашёл адрес в ответе ${serviceName}.`
        );
      }
      return { email, token };
    },

    async getMessages(token) {
      const req = buildRequest(cfg.getMessages, { token: String(token ?? "") });
      const data = await providerFetch(req.url, {
        method: req.method,
        headers: req.headers,
        serviceName,
      });
      const rm = cfg.getMessages.responseMapping;
      let list = getPath(data, rm.messages);
      if (!Array.isArray(list)) {
        // запасной вариант: если путь указал на объект-обёртку — ищем первый массив внутри
        if (list && typeof list === "object") {
          list = Object.values(list).find((v) => Array.isArray(v)) ?? list;
        }
      }
      if (!Array.isArray(list)) {
        throw new ProviderError(
          "provider_unavailable",
          `Маппинг responseMapping.messages («${rm.messages}») не нашёл массив писем в ответе ${serviceName}.`
        );
      }
      const messages = list.slice(0, 20).map((item) => {
        const get = (field) => {
          const configured = rm[field];
          if (configured) {
            const v = getPath(item, configured);
            if (v !== undefined && v !== null) return v;
          }
          for (const p of MESSAGE_FIELD_FALLBACKS[field]) {
            const v = getPath(item, p);
            if (v !== undefined && v !== null) return v;
          }
          return null;
        };
        const received = get("receivedAt");
        const numeric = Number(received);
        return {
          from: String(get("from") ?? ""),
          subject: String(get("subject") ?? "(без темы)"),
          body: String(get("body") ?? "").slice(0, 20000),
          html: String(get("html") ?? "").slice(0, 60000),
          // epoch-секунды и миллисекунды; строки-даты через Date.parse
          receivedAt:
            received == null
              ? null
              : Number.isFinite(numeric) && numeric > 0
                ? numeric < 1e12
                  ? numeric * 1000
                  : numeric
                : Date.parse(String(received)) || null,
        };
      });
      return { messages, expired: false };
    },

    // Кастомный провайдер не имеет дешёвого эндпоинта здоровья — считаем валидный конфик признаком жизни
    async healthCheck() {
      return { ok: true };
    },
  };
}
