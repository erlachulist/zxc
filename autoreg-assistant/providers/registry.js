/**
 * AutoReg Assistant — реестр email-провайдеров (фаза 7/8).
 *
 * Объединяет встроенные модули (tempmail-lol, mail-tm, guerrillamail)
 * и кастомные провайдеры из ar_providers.custom. Отвечает за:
 *  - выбор по стратегии: rotation (по кругу) | random | perSiteSuccess
 *    (последний успешный для домена сайта из ar_siteProvider);
 *  - порядок failover: выбранный провайдер первым, остальные — запасными;
 *  - чёрный список email-доменов сайта (ar_domainBlacklist): провайдер,
 *    у которого все домены в блэклисте, пропускается; если домены динамические
 *    (domains: []) — адрес проверяется после создания ящика.
 */

import { ProviderError } from "./provider-interface.js";
import * as tempmailLol from "./builtin/tempmail-lol.js";
import * as mailTm from "./builtin/mail-tm.js";
import * as guerrillaMail from "./builtin/guerrillamail.js";
import { createCustomProvider } from "./custom-parser.js";

const BUILTIN = [tempmailLol, mailTm, guerrillaMail];

// Счётчик round-robin для стратегии rotation. SW в MV3 засыпает через ~30 с
// простоя, и счётчик в памяти каждый раз стартовал бы с нуля → «ротация»
// всегда выбирала первого провайдера. Поэтому храним его в storage.local.
const ROTATION_KEY = "ar_rotationIndex";
let rotationCounter = 0;
let rotationLoaded = false;

/** Подгружает сохранённый индекс ротации (один раз за жизнь SW). */
export async function loadRotationCounter() {
  if (rotationLoaded) return rotationCounter;
  try {
    const { [ROTATION_KEY]: saved } = await chrome.storage.local.get(ROTATION_KEY);
    if (Number.isInteger(saved) && saved >= 0) rotationCounter = saved;
  } catch {
    /* без storage ротация живёт в памяти */
  }
  rotationLoaded = true;
  return rotationCounter;
}

function bumpRotationCounter() {
  rotationCounter = (rotationCounter + 1) % 1_000_000;
  try {
    chrome.storage.local.set({ [ROTATION_KEY]: rotationCounter }).catch?.(() => {});
  } catch {
    /* запись — best effort */
  }
}

/** Модуль builtin по id (независимо от того, включён ли он). */
export function getBuiltinById(id) {
  return BUILTIN.find((p) => p.meta.id === id) ?? null;
}

/** Список встроенных провайдеров для UI: [{ id, title, domains }]. */
export function listBuiltinProviders() {
  // name дублирует title: UI (popup/options) читает поле name
  return BUILTIN.map((p) => ({ id: p.meta.id, title: p.meta.title, name: p.meta.title, domains: [...p.meta.domains] }));
}

/**
 * Полный список провайдеров: включённые builtin + включённые custom.
 * @param {object} providersConfig — ar_providers.
 * @param {object} [opts] includeDisabled — вернуть и выключенных
 * (нужно pickOrder для понятной ошибки «провайдер отключён», фаза 7).
 * @returns {Array} — провайдеры с общим контрактом meta/createInbox/getMessages/healthCheck.
 */
export function buildProviderList(providersConfig = {}, { includeDisabled = false } = {}) {
  const result = BUILTIN.filter((p) => includeDisabled || providersConfig?.builtin?.[p.meta.id] !== false);

  for (const cfg of providersConfig?.custom ?? []) {
    if (!includeDisabled && cfg?.enabled === false) continue;
    try {
      result.push(createCustomProvider(cfg));
    } catch {
      // битый кастомный конфиг не должен валить весь реестр — пропускаем
    }
  }
  return result;
}

/** Домен email-адреса (после @, нижний регистр). */
function domainOf(email) {
  return String(email ?? "").split("@")[1]?.toLowerCase() ?? "";
}

/** Провайдер полностью попадает в блэклист сайта? (только для известных доменов) */
function isFullyBlacklisted(provider, blacklist) {
  const domains = provider.meta.domains ?? [];
  if (domains.length === 0) return false; // домены динамические — проверим после createInbox
  return domains.every((d) => blacklist.includes(String(d).toLowerCase()));
}

/**
 * Порядок провайдеров для попыток генерации.
 * @param {object} opts
 *   providerName   — явный выбор (имеет приоритет, остальные — запасные);
 *   strategy       — rotation | random | perSiteSuccess;
 *   providers      — включённые провайдеры (buildProviderList);
 *   allProviders   — все, включая выключенных (для ошибки «отключён»);
 *   siteProviderMap — ar_siteProvider;
 *   siteDomain     — домен сайта (для perSiteSuccess);
 *   blacklist      — заблокированные email-домены сайта.
 * @returns {Array} — упорядоченный список; пустой, если включённых нет.
 */
export function pickOrder({
  providerName,
  strategy = "rotation",
  providers = [],
  allProviders = providers,
  siteProviderMap = {},
  siteDomain = "",
  blacklist = [],
} = {}) {
  const list = providers.filter((p) => !isFullyBlacklisted(p, blacklist));

  // Явный выбор из popup: он первым, остальные — failover-запас
  if (providerName) {
    const chosen = allProviders.find((p) => p.meta.id === providerName);
    if (!chosen) {
      throw new ProviderError("provider_unavailable", `Провайдер «${providerName}» не найден.`);
    }
    if (!providers.some((p) => p.meta.id === providerName)) {
      throw new ProviderError("provider_unavailable", `Провайдер «${chosen.meta.title}» отключён в настройках.`);
    }
    if (isFullyBlacklisted(chosen, blacklist)) {
      throw new ProviderError("domain_rejected", `Все домены провайдера «${chosen.meta.title}» заблокированы для этого сайта.`);
    }
    return [chosen, ...list.filter((p) => p !== chosen)];
  }

  if (list.length === 0) {
    throw new ProviderError("provider_unavailable", "Нет доступных провайдеров email (всё отключено или заблокировано).");
  }

  if (strategy === "random") {
    // Фишер–Йетс на месте: перемешиваем порядок попыток
    const shuffled = [...list];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return shuffled;
  }

  if (strategy === "perSiteSuccess" && siteDomain) {
    const rememberedId = siteProviderMap[String(siteDomain).toLowerCase()];
    const remembered = rememberedId && list.find((p) => p.meta.id === rememberedId);
    if (remembered) {
      return [remembered, ...list.filter((p) => p !== remembered)];
    }
    // нет успешного провайдера для сайта — деградируем в rotation
  }

  // rotation: сдвигаем список на текущий счётчик
  const start = list.length > 0 ? rotationCounter % list.length : 0;
  bumpRotationCounter();
  return [...list.slice(start), ...list.slice(0, start)];
}

/**
 * Генерация email с failover между провайдерами (фаза 7).
 * Идёт по порядку pickOrder; на сетевых/лимитных ошибках переходит к
 * следующему провайдеру с паузой backoff; адрес из блэклиста сайта
 * (динамические домены) перегенерируется до 3 раз на провайдера.
 *
 * @returns {{email, token, provider}} — плюс attempts[] со сводкой неудач
 * (для лога попыток записи, фаза 6).
 */
export async function createInboxWithFailover({
  order,
  siteDomain = "",
  blacklist = [],
  baseDelayMs = 1000,
  onProviderError = null, // колбэк (err, provider) для логирования попыток
} = {}) {
  const bl = (blacklist ?? []).map((d) => String(d).toLowerCase());
  const failures = [];
  let lastError = null;

  for (let i = 0; i < order.length; i++) {
    const provider = order[i];
    // До 3 ящиков на провайдера: адрес может попасть в блэклист домена
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const { email, token } = await provider.createInbox();
        const domain = domainOf(email);
        if (siteDomain && domain && bl.includes(domain)) {
          failures.push({
            timestamp: Date.now(),
            error: `Провайдер ${provider.meta.title} выдал адрес на заблокированном домене ${domain}`,
            errorType: "domain_rejected",
            domain,
          });
          continue; // перегенерировать адрес у этого же провайдера
        }
        return { email, token, provider, attempts: failures };
      } catch (err) {
        lastError = err;
        failures.push({
          timestamp: Date.now(),
          error: err?.message || String(err),
          errorType: err?.errorType || "unknown",
          domain: provider.meta.title,
        });
        onProviderError?.(err, provider);
        const fatal = !["network", "provider_unavailable", "rate_limit"].includes(err?.errorType);
        if (fatal) break; // конфиг/домен провайдера — к следующему провайдеру
        break; // сетевая/лимитная ошибка — тоже к следующему (failover)
      }
    }
    // пауза перед следующим провайдером — только если он есть
    if (i < order.length - 1 && baseDelayMs > 0) {
      await new Promise((r) => setTimeout(r, Math.min(baseDelayMs * 2 ** i, 15000)));
    }
  }

  const detail = lastError?.message ?? "провайдеры недоступны";
  // Тип финальной ошибки = тип последнего сбоя (network остаётся network и т.д.)
  const finalType = ["network", "rate_limit", "provider_unavailable"].includes(lastError?.errorType)
    ? lastError.errorType
    : "provider_unavailable";
  throw new ProviderError(finalType, `Не удалось создать email: ${detail}. Попробуйте ещё раз или выберите другого провайдера.`, {
    cause: lastError,
  });
}
