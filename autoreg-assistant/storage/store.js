/**
 * AutoReg Assistant — доступ к chrome.storage.local (ключи ar_*, см. schema.js).
 *
 * Все операции с записями идут через этот модуль, чтобы формат записей
 * жил в одном месте. Функции безопасны при повторном вызове.
 */

import { SCHEMA_VERSION, DEFAULT_SETTINGS, DEFAULT_PROVIDERS, RECORD_STATUS, defaultState, uuid } from "./schema.js";

const RECORDS_KEY = "ar_records";

// ---------------------------------------------------------------------------
// Инициализация / миграция схемы
// ---------------------------------------------------------------------------

/**
 * Гарантирует, что все ключи ar_* существуют.
 * - Первая установка: создаёт полное состояние по умолчанию.
 * - Обновление с более старой версии: добавляет только отсутствующие ключи
 *   и дополняет ar_settings / ar_providers новыми полями по умолчанию,
 *   не трогая существующие данные пользователя.
 * Безопасно вызывать многократно (onInstalled, onStartup, холодный старт SW).
 */
export async function initStore() {
  const stored = await chrome.storage.local.get(null);
  const patch = {};

  if (stored.ar_schemaVersion === undefined) {
    Object.assign(patch, defaultState());
  } else {
    const defaults = defaultState();
    for (const key of Object.keys(defaults)) {
      if (stored[key] === undefined) patch[key] = defaults[key];
    }
    if (stored.ar_settings) {
      patch.ar_settings = { ...DEFAULT_SETTINGS, ...stored.ar_settings };
    }
    if (stored.ar_providers) {
      patch.ar_providers = {
        builtin: { ...DEFAULT_PROVIDERS.builtin, ...(stored.ar_providers.builtin ?? {}) },
        custom: Array.isArray(stored.ar_providers.custom) ? stored.ar_providers.custom : [],
      };
    }
  }

  if (stored.ar_schemaVersion !== SCHEMA_VERSION) patch.ar_schemaVersion = SCHEMA_VERSION;
  if (Object.keys(patch).length > 0) await chrome.storage.local.set(patch);
}

// ---------------------------------------------------------------------------
// Записи о регистрациях
// ---------------------------------------------------------------------------

/**
 * Очередь записей в ar_records. Поллинг, контент и popup пишут в один массив
 * конкурентно; без сериализации read-modify-write теряет чужие изменения
 * (v3.1: гонка «attempts от тика поллинга затирает status от SUBMITTED»).
 */
let recordsQueue = Promise.resolve();
function withRecordsLock(fn) {
  const run = recordsQueue.then(fn, fn);
  recordsQueue = run.catch(() => {});
  return run;
}

/** Список записей (новые — первыми). Если ключа ещё нет — пустой массив. */
export async function getRecords() {
  const { ar_records } = await chrome.storage.local.get(RECORDS_KEY);
  return Array.isArray(ar_records) ? ar_records : [];
}

/** Запись по id или null. */
export async function getRecord(id) {
  if (!id) return null;
  const records = await getRecords();
  return records.find((r) => r.id === id) ?? null;
}

/**
 * Создаёт запись со статусом "generated" и добавляет в начало списка.
 * Возвращает созданную запись целиком (включая id).
 */
export async function createRecord({
  email,
  emailToken = "",
  providerName = "",
  domain = "",
  siteName = "",
  url = "",
  password = "",
  username = "",
}) {
  if (!email) throw new Error("createRecord: email обязателен");
  const now = Date.now();
  const record = {
    id: uuid(),
    domain,
    siteName,
    url,
    email,
    emailToken,
    providerName,
    password,
    username,
    status: RECORD_STATUS.GENERATED,
    attempts: [],
    verification: { otpCode: null, link: null, messageCount: 0 },
    tags: [],
    notes: "",
    createdAt: now,
    updatedAt: now,
  };
  await withRecordsLock(async () => {
    const records = await getRecords();
    records.unshift(record);
    await chrome.storage.local.set({ [RECORDS_KEY]: records });
  });
  return record;
}

/**
 * Обновляет запись: merge патча + updatedAt.
 * @param {string} id
 * @param {object|function(current): object} patch — объект-патч или функция,
 *        получающая копию текущей записи (удобно для вычисляемых полей).
 * @returns обновлённая запись или null, если запись не найдена.
 */
export async function updateRecord(id, patch) {
  return withRecordsLock(async () => {
    const records = await getRecords();
    const index = records.findIndex((r) => r.id === id);
    if (index === -1) return null;
    const current = records[index];
    const changes = typeof patch === "function" ? patch({ ...current }) : patch;
    records[index] = { ...current, ...changes, updatedAt: Date.now() };
    await chrome.storage.local.set({ [RECORDS_KEY]: records });
    return records[index];
  });
}

/** Удаляет запись по id. */
export async function deleteRecord(id) {
  return withRecordsLock(async () => {
    const records = await getRecords();
    await chrome.storage.local.set({ [RECORDS_KEY]: records.filter((r) => r.id !== id) });
  });
}

/** Добавляет попытку в attempts[] записи (фаза 6: лог всех ретраев). */
export async function appendAttempt(id, { error, errorType, domain }) {
  return updateRecord(id, (current) => ({
    attempts: [
      ...(current.attempts ?? []),
      { timestamp: Date.now(), error: String(error ?? "").slice(0, 200), errorType: String(errorType ?? "unknown"), domain: String(domain ?? "") },
    ],
  }));
}

/** Меняет статус записи (с защитой от неизвестных значений). */
export async function setStatus(id, status) {
  const valid = Object.values(RECORD_STATUS);
  if (!valid.includes(status)) throw new Error(`Неизвестный статус: ${status}`);
  return updateRecord(id, { status });
}

// ---------------------------------------------------------------------------
// Чёрный список email-доменов по сайтам (фаза 6)
// ---------------------------------------------------------------------------

/** Карта { домен сайта: [заблокированные email-домены] }. */
export async function getDomainBlacklist() {
  const { ar_domainBlacklist } = await chrome.storage.local.get("ar_domainBlacklist");
  return ar_domainBlacklist && typeof ar_domainBlacklist === "object" ? ar_domainBlacklist : {};
}

/** Блэклист конкретного сайта (пустой массив, если сайта нет в карте). */
export async function getBlacklistForSite(siteDomain) {
  const map = await getDomainBlacklist();
  const list = map[siteDomain];
  return Array.isArray(list) ? list : [];
}

/** Добавляет email-домен в блэклист сайта (идемпотентно, persist). */
export async function blacklistEmailDomain(siteDomain, emailDomain) {
  const key = String(siteDomain ?? "").toLowerCase();
  const value = String(emailDomain ?? "").toLowerCase();
  if (!key || !value) return;
  const map = await getDomainBlacklist();
  const list = new Set(Array.isArray(map[key]) ? map[key] : []);
  list.add(value);
  map[key] = [...list];
  await chrome.storage.local.set({ ar_domainBlacklist: map });
}

// ---------------------------------------------------------------------------
// Последний успешный провайдер по сайту (стратегия perSiteSuccess, фаза 7)
// ---------------------------------------------------------------------------

export async function getSiteProviderMap() {
  const { ar_siteProvider } = await chrome.storage.local.get("ar_siteProvider");
  return ar_siteProvider && typeof ar_siteProvider === "object" ? ar_siteProvider : {};
}

/** Запоминает провайдера, успешно сгенерировавшего email для сайта. */
export async function setSiteProvider(siteDomain, providerId) {
  const key = String(siteDomain ?? "").toLowerCase();
  if (!key || !providerId) return;
  const map = await getSiteProviderMap();
  map[key] = String(providerId);
  await chrome.storage.local.set({ ar_siteProvider: map });
}

// ---------------------------------------------------------------------------
// Настройки и конфигурация провайдеров
// ---------------------------------------------------------------------------

/** Настройки с заполненными дефолтами (на случай новых полей в будущих версиях). */
export async function getSettings() {
  const { ar_settings } = await chrome.storage.local.get("ar_settings");
  return { ...DEFAULT_SETTINGS, ...(ar_settings ?? {}) };
}

/** Сохраняет настройки (merge поверх текущих). Возвращает итоговые настройки. */
export async function saveSettings(patch) {
  const current = await getSettings();
  const next = { ...current, ...(patch ?? {}) };
  await chrome.storage.local.set({ ar_settings: next });
  return next;
}

/** Конфигурация провайдеров: включённость builtin + кастомные конфиги (фаза 8). */
export async function getProvidersConfig() {
  const { ar_providers } = await chrome.storage.local.get("ar_providers");
  return {
    builtin: { ...DEFAULT_PROVIDERS.builtin, ...(ar_providers?.builtin ?? {}) },
    custom: Array.isArray(ar_providers?.custom) ? ar_providers.custom : [],
  };
}

/** Включает/выключает провайдера (builtin или custom:…). */
export async function setProviderEnabled(id, enabled) {
  const config = await getProvidersConfig();
  if (String(id).startsWith("custom:")) {
    config.custom = config.custom.map((c) => (c.id === id ? { ...c, enabled: Boolean(enabled) } : c));
  } else {
    config.builtin = { ...config.builtin, [id]: Boolean(enabled) };
  }
  await chrome.storage.local.set({ ar_providers: config });
  return config;
}

/** Полная замена списка кастомных провайдеров (экран Manage Providers). */
export async function saveCustomProviders(custom) {
  const config = await getProvidersConfig();
  config.custom = Array.isArray(custom) ? custom : [];
  await chrome.storage.local.set({ ar_providers: config });
  return config;
}

// ---------------------------------------------------------------------------
// Обслуживание журнала
// ---------------------------------------------------------------------------

/**
 * Автоочистка записей старше autoDeleteDays дней (0 = выключена).
 * v3: verified-записи НЕ удаляются (в них пароли работающих аккаунтов —
 * поведение перенесено из v2, где оно безопаснее). Удаляются только
 * failed/generated и неактивные старые записи.
 * Вызывается при старте SW. Возвращает число удалённых записей.
 */
export async function cleanupOldRecords(settings) {
  const days = Number(settings?.autoDeleteDays ?? 0);
  if (!days || days <= 0) return 0;
  const deadline = Date.now() - days * 86400000;
  return withRecordsLock(async () => {
    const records = await getRecords();
    const keep = records.filter((r) => {
      const fresh = (r.updatedAt ?? r.createdAt ?? 0) >= deadline;
      if (fresh) return true;
      const removable = r.status === RECORD_STATUS.FAILED || r.status === RECORD_STATUS.GENERATED;
      return !removable;
    });
    if (keep.length !== records.length) {
      await chrome.storage.local.set({ [RECORDS_KEY]: keep });
      return records.length - keep.length;
    }
    return 0;
  });
}

// ---------------------------------------------------------------------------
// Мета шифрования (v3): ar_crypto = {enabled, salt, verifier}
// ---------------------------------------------------------------------------

const CRYPTO_KEY = "ar_crypto";

/** Мета шифрования (или {enabled:false}). */
export async function getCryptoMeta() {
  const { [CRYPTO_KEY]: meta } = await chrome.storage.local.get(CRYPTO_KEY);
  return meta && typeof meta === "object" ? meta : { enabled: false };
}

/** Записать мету шифрования. */
export async function setCryptoMeta(meta) {
  await chrome.storage.local.set({ [CRYPTO_KEY]: meta });
}

/** Удалить мету шифрования (выключение). */
export async function clearCryptoMeta() {
  await chrome.storage.local.remove(CRYPTO_KEY);
}

/** Мастер-пароль сессии (chrome.storage.session; SW-перезапуск = блокировка). */
export async function getSessionMaster() {
  try {
    const { ar_master } = await chrome.storage.session.get("ar_master");
    return ar_master || null;
  } catch {
    return null;
  }
}

export async function setSessionMaster(password) {
  await chrome.storage.session.set({ ar_master: String(password ?? "") });
}

export async function clearSessionMaster() {
  try {
    await chrome.storage.session.remove("ar_master");
  } catch {
    /* session может отсутствовать в тестах */
  }
}
