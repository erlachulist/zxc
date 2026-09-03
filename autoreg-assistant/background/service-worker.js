/**
 * AutoReg Assistant — background service worker v3 (Manifest V3, ES-модули).
 *
 * Финальная сборка: база v1 (фазы 2–9) + лучшее из v2 + все фиксы багов.
 *
 * Зоны ответственности:
 *  - все внешние HTTP-запросы (провайдеры временной почты);
 *  - пайплайн заполнения форм: INSPECT_FIELDS (с видом формы) → генерация
 *    личности → FILL_FIELDS → запись form_filled;
 *  - v3 ЛОГИН: если на странице форма ВХОДА и для сайта есть запись в
 *    журнале — заполнение сохранёнными данными БЕЗ создания новой записи
 *    (фикс бага «после подтверждения предлагает новую регистрацию»);
 *  - v3 FILL_RECORD: заполнение формы на вкладке данными конкретной записи
 *    (кнопка «Заполнить» в журнале popup);
 *  - v3 REGENERATE_PASSWORD: перегенерация пароля под требования шага 2
 *    многошаговой формы (по запросу content-сессии);
 *  - v3 шифрование паролей (PBKDF2 + AES-GCM, порт из v2);
 *  - v3 хоткей Ctrl+Shift+F (commands) и подменю провайдеров;
 *  - ретраи с классификацией ошибок, поллинг входящих, OTP (с авто-
 *    подтверждением кнопкой), ссылки, уведомления, badge, автоочистка.
 *
 * Протокол сообщений: {type, ...payload} → {ok: true, ...data} |
 * {ok: false, error, errorType}. Все слушатели регистрируются синхронно.
 */

import {
  initStore,
  getSettings,
  saveSettings,
  getRecords,
  getRecord,
  createRecord,
  updateRecord,
  deleteRecord,
  appendAttempt,
  setStatus,
  getBlacklistForSite,
  blacklistEmailDomain,
  getSiteProviderMap,
  setSiteProvider,
  getProvidersConfig,
  setProviderEnabled,
  saveCustomProviders,
  cleanupOldRecords,
  getCryptoMeta,
  setCryptoMeta,
  clearCryptoMeta,
  getSessionMaster,
  setSessionMaster,
  clearSessionMaster,
} from "../storage/store.js";
import { RECORD_STATUS } from "../storage/schema.js";
import { buildProviderList, pickOrder, createInboxWithFailover, listBuiltinProviders, getBuiltinById, loadRotationCounter } from "../providers/registry.js";
import { validateConfig, createCustomProvider, customProviderId } from "../providers/custom-parser.js";
import { generatePassword, generateUsername, meetsTextRequirements } from "../core/password-generator.js";
import { parseMessages } from "../core/email-parser.js";
import { classifyPageText, emailDomainOf } from "../core/error-classifier.js";
import { decideRetry, sleep } from "../core/retry.js";
import * as crypto from "../core/crypto.js";

/** Ошибка уровня приложения с типом из протокола сообщений. */
class AppError extends Error {
  constructor(errorType, message) {
    super(message);
    this.name = "AppError";
    this.errorType = errorType;
  }
}

const POLL_ALARM = "ar-poll-wakeup";
const MENU_FILL = "autoreg-fill";
const MENU_EMAIL = "autoreg-email";
const MENU_PROV_PREFIX = "autoreg-prov::";
const POLLS_KEY = "ar_activePolls"; // storage.session

// Инициализация хранилища. ВАЖНО: слушатели регистрируются синхронно,
// поэтому initStore НЕ await-ится на верхнем уровне — top-level await в SW
// задержал бы регистрацию обработчиков, и сообщения при холодном старте терялись бы.
const storeReady = initStore();
storeReady.catch(() => {});

chrome.runtime.onInstalled.addListener(() => {
  onInstalled().catch(() => {});
});
chrome.runtime.onStartup.addListener(() => {
  onStartup().catch(() => {});
});

async function onInstalled() {
  await storeReady;
  await initStore();
  await cleanupOldRecords(await getSettings());
  await rebuildContextMenus();
}

async function onStartup() {
  await storeReady;
  await cleanupOldRecords(await getSettings());
  await rebuildContextMenus();
}

// ---------------------------------------------------------------------------
// Контекстное меню (v3: + подменю провайдеров, как в v2)
// ---------------------------------------------------------------------------

async function rebuildContextMenus() {
  const removeAll = () =>
    new Promise((resolve) => chrome.contextMenus.removeAll(() => resolve()));
  await removeAll();
  chrome.contextMenus.create({
    id: MENU_FILL,
    title: "AutoReg: заполнить форму",
    contexts: ["page", "editable", "frame"],
  });
  chrome.contextMenus.create({
    id: MENU_EMAIL,
    title: "AutoReg: только email",
    contexts: ["editable", "page"],
  });
  try {
    const config = await getProvidersConfig();
    const providers = buildProviderList(config); // только включённые
    if (providers.length) {
      chrome.contextMenus.create({
        id: "autoreg-prov-parent",
        title: "Сгенерировать email через…",
        contexts: ["editable", "page"],
      });
      for (const p of providers) {
        chrome.contextMenus.create({
          id: MENU_PROV_PREFIX + p.meta.id,
          parentId: "autoreg-prov-parent",
          title: p.meta.title,
          contexts: ["editable", "page"],
        });
      }
    }
  } catch {
    /* меню провайдеров — не критичный путь */
  }
}

// ---------------------------------------------------------------------------
// Шифрование (v3, порт из v2): ключ в памяти SW, соль+верификатор в local
// ---------------------------------------------------------------------------

/** Ключ сессии или null (шифрование выключено / не разблокировано). */
async function deriveSessionKey() {
  const meta = await getCryptoMeta();
  const master = await getSessionMaster();
  if (!meta.enabled || !master || !meta.salt) return null;
  return crypto.deriveKey(master, meta.salt);
}

/** Пароль → {value, encrypted} (шифруем, если включено и разблокировано). */
async function maybeEncrypt(plain) {
  if (!plain) return { value: plain || "", encrypted: false };
  const key = await deriveSessionKey();
  if (!key) return { value: plain, encrypted: false };
  return { value: await crypto.encryptString(key, plain), encrypted: true };
}

/** Зашифрованное значение → расшифрованное (или null, если нельзя). */
async function maybeDecrypt(value) {
  if (!crypto.isEncrypted(value)) return value;
  const key = await deriveSessionKey();
  if (!key) return null;
  try {
    return await crypto.decryptString(key, value);
  } catch {
    return null;
  }
}

async function encryptAllExisting(key) {
  const list = await getRecords();
  for (const r of list) {
    if (r.password && !crypto.isEncrypted(r.password)) {
      await updateRecord(r.id, { password: await crypto.encryptString(key, r.password), encrypted: true });
    }
  }
}

async function decryptAllExisting(key) {
  const list = await getRecords();
  for (const r of list) {
    if (crypto.isEncrypted(r.password)) {
      try {
        await updateRecord(r.id, { password: await crypto.decryptString(key, r.password), encrypted: false });
      } catch {
        /* неверный ключ — оставляем как есть */
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Связь с контентом на вкладке
// ---------------------------------------------------------------------------

/**
 * Отправляет сообщение content-скрипту. Если тот не внедрён (вкладка была
 * открыта до установки расширения) — внедряет и ждёт, пока модули загрузятся.
 */
async function sendToTab(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch {
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ["content/content.js"] });
    } catch {
      throw new AppError("form_not_found", "Расширению недоступна эта страница (chrome://, магазин Chrome, PDF и т.п.). Откройте обычный сайт.");
    }
    // Контент-модули подгружаются динамически — даём им подняться
    for (let i = 0; i < 10; i++) {
      await sleep(250);
      try {
        return await chrome.tabs.sendMessage(tabId, message);
      } catch {
        /* повторяем */
      }
    }
    throw new AppError("unknown", "Страница не ответила. Обновите её (F5) и попробуйте снова.");
  }
}

// ---------------------------------------------------------------------------
// Генерация email (стратегии + failover + блэклист доменов сайта)
// ---------------------------------------------------------------------------

/** Порядок провайдеров под текущие настройки и сайт. */
async function providerOrder({ providerName = null, siteDomain = "" } = {}) {
  const settings = await getSettings();
  const providersConfig = await getProvidersConfig();
  await loadRotationCounter();
  const blacklist = siteDomain ? await getBlacklistForSite(siteDomain) : [];
  const providers = buildProviderList(providersConfig);
  const allProviders = buildProviderList(providersConfig, { includeDisabled: true });
  const siteProviderMap = siteDomain ? await getSiteProviderMap() : {};
  const order = pickOrder({
    providerName,
    strategy: settings.providerStrategy,
    providers,
    allProviders,
    siteProviderMap,
    siteDomain,
    blacklist,
  });
  return { order, settings, blacklist };
}

/**
 * Генерация email с failover. Возвращает { email, token, provider, failures } —
 * failures (попытки провайдеров) вызывающий код допишет в attempts[] записи.
 */
async function generateEmail({ providerName = null, siteDomain = "" } = {}) {
  const { order, settings, blacklist } = await providerOrder({ providerName, siteDomain });
  return createInboxWithFailover({ order, siteDomain, blacklist, baseDelayMs: settings.retryBaseDelayMs });
}

// ---------------------------------------------------------------------------
// v3: выбор записи журнала для входа (форма логина на знакомом сайте)
// ---------------------------------------------------------------------------

const LOGIN_STATUS_PRIORITY = [
  RECORD_STATUS.VERIFIED,
  RECORD_STATUS.PENDING_VERIFICATION,
  RECORD_STATUS.SUBMITTED,
  RECORD_STATUS.FORM_FILLED,
  RECORD_STATUS.GENERATED,
  RECORD_STATUS.FAILED,
];

/** Лучшая запись для входа на сайт: verified → pending → …, новые первее. */
async function pickLoginRecord(siteDomain) {
  if (!siteDomain) return null;
  const records = await getRecords();
  const candidates = records.filter(
    (r) => String(r.domain ?? "").toLowerCase() === siteDomain && (r.password || r.encrypted)
  );
  if (!candidates.length) return null;
  candidates.sort((a, b) => {
    const pa = LOGIN_STATUS_PRIORITY.indexOf(a.status);
    const pb = LOGIN_STATUS_PRIORITY.indexOf(b.status);
    if (pa !== pb) return pa - pb;
    return (b.updatedAt ?? 0) - (a.updatedAt ?? 0);
  });
  return candidates[0];
}

/** Личность записи для заполнения (с расшифровкой пароля при необходимости). */
async function identityForRecord(record) {
  let password = record.password ?? "";
  if (crypto.isEncrypted(password)) {
    const plain = await maybeDecrypt(password);
    if (plain == null) {
      throw new AppError("crypto_locked", "Пароль зашифрован — разблокируйте его мастер-паролем (popup или настройки).");
    }
    password = plain;
  }
  return { email: record.email, password, username: record.username ?? generateUsername(record.email) };
}

// ---------------------------------------------------------------------------
// Пайплайн заполнения формы (фазы 3–4 + v3 логин-сценарий)
// ---------------------------------------------------------------------------

/** Цепочки авто-ретраев по вкладкам: recordId → {count} (защита от бесконечного цикла). */
const refillChains = new Map();

/**
 * Полный сценарий: инспекция полей → email (+failover) → пароль под требования
 * → заполнение → запись form_filled. Используют popup (FILL_FORM), контекстное
 * меню, инлайн-кнопка (RUN_FILL) и хоткей.
 *
 * v3: если на странице форма ВХОДА (formKind=login) и в журнале есть запись
 * для этого сайта — заполняем сохранёнными данными, новую запись НЕ создаём.
 * @param {number} tabId
 * @param {object} [opts] emailOnly — заполнить только email (режим «только email»).
 */
async function fillFormInTab(tabId, { emailOnly = false, providerName = null } = {}) {
  await storeReady;
  if (!tabId) throw new AppError("unknown", "Не удалось определить вкладку.");

  // 1. Что за форма на странице и какие требования к паролю
  const inspect = await sendToTab(tabId, { type: "INSPECT_FIELDS" });
  if (!inspect) throw new AppError("unknown", "Страница не ответила. Обновите её (F5) и попробуйте снова.");
  if (!inspect.hasForm) {
    throw new AppError(
      "form_not_found",
      "Поля регистрации на странице не найдены. Откройте страницу с формой (email/пароль) и повторите."
    );
  }
  // Шаг 1 многошаговой формы (только email): пароль генерируем сейчас, поля
  // пароля заполнит content-сессия, когда сайт покажет шаг 2
  const emailOnlyStep = Boolean(inspect.emailOnlyStep);

  const siteDomain = String(inspect.domain ?? "").toLowerCase();
  const settings = await getSettings();

  // 2. v3: форма входа + есть запись → заполняем сохранёнными данными
  if (!emailOnly && inspect.formKind === "login") {
    const existing = await pickLoginRecord(siteDomain);
    if (existing) {
      return fillWithRecordInTab(tabId, existing, { login: true, banner: true });
    }
    // записей нет — пользователь впервые на сайте, регистрируемся как обычно
  }

  // 3. Email с учётом блэклиста сайта и failover между провайдерами
  const { email, token, provider, attempts: failures } = await generateEmail({ providerName, siteDomain });

  // 4. Пароль под требования полей (minlength/maxlength/confirm/pattern/текст)
  const { password } = generatePassword(inspect.requirements ?? {});
  const username = generateUsername(email);

  // 5. Запись: создаётся до заполнения, чтобы контент знал recordId
  //    для детекта сабмита; при неудаче заполнения запись удаляется.
  const enc = await maybeEncrypt(password);
  const record = await createRecord({
    email,
    emailToken: token,
    providerName: provider.meta.id,
    domain: siteDomain,
    siteName: String(inspect.title ?? "").slice(0, 80) || siteDomain,
    url: String(inspect.url ?? ""),
    password: enc.value,
    username,
  });
  await updateRecord(record.id, { encrypted: enc.encrypted });
  for (const f of failures ?? []) {
    await appendAttempt(record.id, f);
  }

  // 6. Заполнение полей
  const fillMode = emailOnly ? "email" : settings.fillMode;
  const resp = await sendToTab(tabId, {
    type: "FILL_FIELDS",
    identity: { email, password, username },
    recordId: record.id,
    fillMode,
    autoSubmit: settings.autoSubmit && !emailOnly,
  });
  if (!resp?.filled || resp.filled.total === 0) {
    await deleteRecord(record.id);
    throw new AppError("form_not_found", "Поля на странице не заполнились — возможно, форма перерисовалась. Попробуйте снова.");
  }

  // 7. Статус + запомнить успешного провайдера для стратегии perSiteSuccess
  await setStatus(record.id, RECORD_STATUS.FORM_FILLED);
  await updateRecord(record.id, { domain: siteDomain || (record.domain ?? "") });
  if (siteDomain) await setSiteProvider(siteDomain, provider.meta.id);
  if (emailOnlyStep && !emailOnly) {
    await appendAttempt(record.id, {
      error: "шаг 1: заполнен email, пароль будет подставлен на следующем шаге",
      errorType: "step",
      domain: emailDomainOf(email),
    });
  }

  await sendToTab(tabId, {
    type: "SHOW_BANNER",
    text: emailOnlyStep && !emailOnly
      ? `Email заполнен: ${email}. Пароль подставится на следующем шаге.`
      : `Заполнено полей: ${resp.filled.total}. Email: ${email}`,
    autoHideMs: 5000,
  }).catch(() => {});

  return { mode: "register", recordId: record.id, email, providerName: provider.meta.id, filled: resp.filled };
}

/**
 * v3: заполнение формы на вкладке данными конкретной записи журнала.
 * Используется: кнопка «Заполнить» в журнале popup (FILL_RECORD), баннер
 * «Войти как …» (RUN_LOGIN_FILL) и сценарий логина внутри fillFormInTab.
 * Новая запись НЕ создаётся.
 */
async function fillWithRecordInTab(tabId, record, { login = false, banner = true } = {}) {
  const identity = await identityForRecord(record);
  const fillMode = login ? "email+password" : "email+password";

  const resp = await sendToTab(tabId, {
    type: "FILL_FIELDS",
    identity,
    recordId: record.id,
    fillMode,
    autoSubmit: false,
    watch: !login, // для входа не ждём писем верификации
  });
  if (!resp?.filled || resp.filled.total === 0) {
    throw new AppError("form_not_found", "Поля на странице не заполнились — откройте форму и попробуйте снова.");
  }

  await appendAttempt(record.id, {
    error: login ? "форма входа заполнена из журнала" : "форма заполнена из журнала",
    errorType: login ? "login" : "refill",
    domain: emailDomainOf(record.email),
  });

  if (banner) {
    await sendToTab(tabId, {
      type: "SHOW_BANNER",
      text: login ? `Вход заполнен: ${record.email}` : `Заполнено из журнала: ${record.email}`,
      autoHideMs: 5000,
    }).catch(() => {});
  }

  return {
    mode: login ? "login" : "refill",
    recordId: record.id,
    email: record.email,
    filled: resp.filled,
  };
}

// ---------------------------------------------------------------------------
// Поллинг писем после сабмита (фаза 5 + v3 OTP авто-подтверждение)
// ---------------------------------------------------------------------------

/** Активные поллинги: recordId → {tabId, deadline, startedAt, timerId, lastCount, codeSent, linkSent}. */
const polls = new Map();

function persistPolls() {
  const snapshot = {};
  for (const [id, p] of polls) snapshot[id] = { tabId: p.tabId, deadline: p.deadline };
  return chrome.storage.session.set({ [POLLS_KEY]: snapshot }).catch(() => {});
}

async function ensurePollAlarm() {
  try {
    const alarms = await chrome.alarms.getAll();
    if (!alarms.some((a) => a.name === POLL_ALARM)) {
      // Минимальный период MV3-будильника — 30 секунд (Chrome 120+)
      await chrome.alarms.create(POLL_ALARM, { periodInMinutes: 0.5, delayInMinutes: 0.5 });
    }
  } catch {
    /* без alarms поллинг живёт, пока жив SW */
  }
}

async function startPolling(recordId, tabId, { deadline = null } = {}) {
  if (polls.has(recordId)) return;
  const settings = await getSettings();
  const interval = Math.max(Number(settings.pollingIntervalMs) || 5000, 3000);
  const timeoutMs = Math.max(Number(settings.pollingTimeoutMs) || 300000, 15000);
  const poll = {
    tabId,
    // При возобновлении после сна SW сохраняем исходный дедлайн, а не сдвигаем его
    deadline: Number(deadline) > Date.now() ? Number(deadline) : Date.now() + timeoutMs,
    startedAt: Date.now(),
    timerId: null,
    lastCount: 0,
    codeSent: false,
    linkSent: false,
    otpAppliedAt: 0,
  };
  polls.set(recordId, poll);
  await persistPolls();
  await ensurePollAlarm();
  // Активные fetch-циклы держат service worker живым; будильник — страховка сна
  poll.timerId = setInterval(() => tickPoll(recordId).catch(() => {}), interval);
  tickPoll(recordId).catch(() => {});
}

async function stopPolling(recordId) {
  const poll = polls.get(recordId);
  if (!poll) return;
  if (poll.timerId) clearInterval(poll.timerId);
  polls.delete(recordId);
  await persistPolls();
  if (polls.size === 0) {
    chrome.alarms.clear(POLL_ALARM).catch(() => {});
  }
}

/** Один такт поллинга: проверить ящик, разобрать письмо, применить код/ссылку. */
async function tickPoll(recordId) {
  const poll = polls.get(recordId);
  if (!poll) return;
  const record = await getRecord(recordId);
  if (!record || record.status === RECORD_STATUS.VERIFIED || record.status === RECORD_STATUS.FAILED) {
    await stopPolling(recordId);
    return;
  }

  if (Date.now() > poll.deadline) {
    await stopPolling(recordId);
    const minutes = Math.max(1, Math.round((poll.deadline - poll.startedAt) / 60000));
    await appendAttempt(recordId, {
      error: `Письмо не пришло за ${minutes} мин — верификация не завершена`,
      errorType: "unknown",
      domain: "",
    });
    await setStatus(recordId, RECORD_STATUS.FAILED);
    await notify("AutoReg: письмо не пришло", `За ${minutes} мин письмо так и не пришло — регистрация на ${record.domain || "сайте"} не завершена.`, recordId);
    return;
  }

  const provider = await getProviderForRecord(record);
  if (!provider) {
    await stopPolling(recordId);
    await setStatus(recordId, RECORD_STATUS.FAILED);
    return;
  }

  let messages = [];
  try {
    ({ messages } = await provider.getMessages(record.emailToken));
  } catch {
    return; // сетевая/лимитная ошибка — просто следующий такт
  }

  // Код вставлен на прошлом такте и сайт не ответил ошибкой (ERROR_SUBMITTED
  // остановил бы поллинг) — считаем регистрацию подтверждённой
  if (poll.otpAppliedAt && Date.now() - poll.otpAppliedAt > 8000) {
    if (record.status === RECORD_STATUS.PENDING_VERIFICATION) {
      await setStatus(recordId, RECORD_STATUS.VERIFIED);
      await notify("AutoReg: регистрация подтверждена", `Код принят, аккаунт на ${record.domain || "сайте"} подтверждён.`, recordId);
    }
    await stopPolling(recordId);
    return;
  }

  if (messages.length === 0 || messages.length === poll.lastCount) return;

  // Новое письмо (или рост счётчика): обновляем запись и разбираем содержимое
  poll.lastCount = messages.length;
  const parsed = parseMessages(messages);
  await updateRecord(recordId, (cur) => ({
    status: RECORD_STATUS.PENDING_VERIFICATION,
    verification: {
      ...cur.verification,
      messageCount: messages.length,
      otpCode: parsed.code ?? cur.verification.otpCode,
      link: parsed.link ?? cur.verification.link,
    },
  }));

  const last = messages[messages.length - 1];
  await notify(
    "AutoReg: письмо пришло",
    `${last?.from ? `От ${last.from}. ` : ""}${parsed.code ? `Код: ${parsed.code}.` : parsed.link ? "Есть ссылка подтверждения." : "Проверьте почту в расширении."}`,
    recordId
  );

  const settings = await getSettings();

  // Код → вставляем в поле на странице (v3: + авто-подтверждение кнопкой;
  // если поля нет — контент запомнит код и вставит при появлении, плюс баннер)
  if (parsed.code && !poll.codeSent) {
    poll.codeSent = true;
    const resp = await sendToTab(poll.tabId, {
      type: "FILL_OTP",
      code: parsed.code,
      autoConfirm: settings.otpAutoConfirm !== false,
    }).catch(() => null);
    if (resp?.applied) {
      // Код в поле ещё не значит, что сайт его принял: статус verified ставит
      // только PAGE_VERIFIED от контента (тексты успеха) либо таймер ниже
      await appendAttempt(recordId, {
        error: resp.confirmed ? `код ${parsed.code} вставлен, подтверждение отправлено` : `код ${parsed.code} вставлен в поле`,
        errorType: "otp",
        domain: "",
      });
      await notify(
        "AutoReg: код вставлен",
        resp.confirmed
          ? `Код ${parsed.code} подставлен, подтверждение отправлено.`
          : `Код ${parsed.code} подставлен в поле подтверждения.`,
        recordId
      );
      // Даём странице ответить; если ошибки не пришло (ERROR_SUBMITTED сбросил
      // бы поллинг) — считаем регистрацию подтверждённой
      poll.otpAppliedAt = Date.now();
      return;
    }
    // Поле не найдено: код остаётся в записи + баннер, пользователь введёт сам
  }

  // Ссылка → режим из настроек linkMode
  if (parsed.link && !poll.linkSent) {
    poll.linkSent = true;
    await handleVerificationLink(recordId, parsed.link, poll.tabId);
  }
}

/** Ссылка подтверждения: auto — открыть фоновой вкладкой; manual — баннер. */
async function handleVerificationLink(recordId, link, tabId) {
  const settings = await getSettings();
  if (settings.linkMode === "auto") {
    await openVerificationLink(link, recordId);
    await notify("AutoReg: ссылка открыта", "Ссылка подтверждения открыта в фоновой вкладке.", recordId);
  } else {
    await sendToTab(
      tabId,
      {
        type: "SHOW_BANNER",
        text: "Письмо со ссылкой подтверждения получено",
        actionLabel: "Открыть ссылку подтверждения",
        action: { type: "OPEN_LINK", url: link, recordId },
      },
      {}
    ).catch(() => {});
    // статус остаётся pending_verification до клика по баннеру (OPEN_LINK)
  }
}

/** Открывает ссылку фоновой вкладкой (НЕ window.open — фаза 5) и завершает цикл. */
async function openVerificationLink(link, recordId) {
  await chrome.tabs.create({ url: link, active: false }).catch(() => {});
  if (recordId) {
    await setStatus(recordId, RECORD_STATUS.VERIFIED);
    await stopPolling(recordId);
  }
}

/** Провайдер для существующей записи (builtin или custom). */
async function getProviderForRecord(record) {
  const builtin = getBuiltinById(record.providerName);
  if (builtin) return builtin;
  if (String(record.providerName).startsWith("custom:")) {
    // конфиг мог измениться — собираем провайдера на лету
    return buildCustomFromStorage(record.providerName);
  }
  return null;
}

async function buildCustomFromStorage(providerId) {
  const config = await getProvidersConfig();
  const cfg = (config.custom ?? []).find((c) => c.id === providerId);
  if (!cfg) return null;
  try {
    return createCustomProvider(cfg);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Уведомления (фаза 5)
// ---------------------------------------------------------------------------

const notificationRecords = new Map(); // id уведомления → recordId

async function notify(title, message, recordId = null) {
  try {
    const settings = await getSettings();
    if (!settings.notifications) return;
    const id = `ar-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    if (recordId) notificationRecords.set(id, recordId);
    await chrome.notifications.create(id, {
      type: "basic",
      iconUrl: chrome.runtime.getURL("icons/icon48.png"),
      title,
      message,
      priority: 1,
    });
  } catch {
    /* уведомления — не критичный путь */
  }
}

chrome.notifications.onClicked.addListener(async (notificationId) => {
  chrome.notifications.clear(notificationId).catch(() => {});
  const recordId = notificationRecords.get(notificationId) ?? null;
  notificationRecords.delete(notificationId);
  try {
    if (recordId) {
      const record = await getRecord(recordId);
      // Клик открывает вкладку письма-подтверждения…
      if (record?.verification?.link) {
        await openVerificationLink(record.verification.link, null);
        await setStatus(recordId, RECORD_STATUS.VERIFIED);
        await stopPolling(recordId);
        return;
      }
      // …или журнал записей расширения
      await chrome.tabs.create({ url: chrome.runtime.getURL("popup/popup.html") });
      return;
    }
    await chrome.action.openPopup();
  } catch {
    // openPopup может быть недоступен без user gesture — открываем журнал
    chrome.tabs.create({ url: chrome.runtime.getURL("popup/popup.html") }).catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// Badge: значок «✓», когда на вкладке есть форма регистрации
// ---------------------------------------------------------------------------

async function setFormBadge(tabId, found) {
  try {
    await chrome.action.setBadgeText({ tabId, text: found ? "✓" : "" });
    if (found) {
      await chrome.action.setBadgeBackgroundColor({ tabId, color: "#0ea5e9" });
      if (chrome.action.setBadgeTextColor) {
        await chrome.action.setBadgeTextColor({ tabId, color: "#ffffff" });
      }
    }
  } catch {
    // вкладка могла закрыться — игнорируем
  }
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading") {
    chrome.action.setBadgeText({ tabId, text: "" }).catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// Контекстное меню: обработка кликов (фаза 3/4 + v3 подменю провайдеров)
// ---------------------------------------------------------------------------

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab?.id) return;
  const menuItem = String(info.menuItemId);
  try {
    if (menuItem === MENU_FILL) {
      await fillFormInTab(tab.id, {});
    } else if (menuItem === MENU_EMAIL) {
      await fillFormInTab(tab.id, { emailOnly: true });
    } else if (menuItem.startsWith(MENU_PROV_PREFIX)) {
      await fillFormInTab(tab.id, { emailOnly: true, providerName: menuItem.slice(MENU_PROV_PREFIX.length) });
    }
  } catch (err) {
    await sendToTab(tab.id, {
      type: "SHOW_BANNER",
      text: err?.message || "Не удалось заполнить форму",
      isError: true,
      autoHideMs: 6000,
    }).catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// Хоткей Ctrl+Shift+F (v3, порт из v2)
// ---------------------------------------------------------------------------

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "fill-form") return;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return;
    await fillFormInTab(tab.id, {});
  } catch {
    /* горячая клавиша молчит при ошибках — пользователь видит баннер */
  }
});

// ---------------------------------------------------------------------------
// Обработка ошибок сайта и авто-ретраи (фаза 6)
// ---------------------------------------------------------------------------

/**
 * ERROR_SUBMITTED от контента: классифицируем текст, логируем попытку,
 * при domain_rejected/email_taken — новый email и повторное заполнение.
 */
async function handleSubmittedError(recordId, pageText, tabId) {
  const record = await getRecord(recordId);
  if (!record) return { ok: true, ignored: true };

  const classified = classifyPageText(pageText);
  const errorType = classified?.errorType ?? "unknown";
  const snippet = classified?.snippet ?? String(pageText ?? "").slice(0, 160);
  const emailDomain = emailDomainOf(record.email);

  await appendAttempt(recordId, { error: snippet, errorType, domain: emailDomain });
  await stopPolling(recordId); // сайт отверг адрес — письма ждать бессмысленно

  const settings = await getSettings();
  const chain = refillChains.get(recordId) ?? { count: 0 };
  const decision = decideRetry(errorType, chain.count + 1, settings);

  if (errorType === "domain_rejected" && record.domain) {
    // Домен email больше не используем для этого сайта (persist)
    await blacklistEmailDomain(record.domain, emailDomain);
  }

  if (decision.action !== "newEmail" && decision.action !== "retry") {
    // unknown → пауза, показать пользователю; stop → failed
    if (decision.action === "stop") {
      await setStatus(recordId, RECORD_STATUS.FAILED);
    }
    await notify("AutoReg: ошибка регистрации", decision.reason, recordId);
    return { ok: true, action: decision.action, reason: decision.reason };
  }

  if (chain.count >= settings.maxRetries) {
    await setStatus(recordId, RECORD_STATUS.FAILED);
    await notify("AutoReg: попытки исчерпаны", `${decision.reason}. Email: ${record.email}`, recordId);
    return { ok: true, action: "stop", reason: decision.reason };
  }

  // Авто-ретрай: помечаем старую запись failed и заполняем форму заново
  chain.count++;
  await setStatus(recordId, RECORD_STATUS.FAILED);
  await notify(
    "AutoReg: перегенерирую email",
    `${decision.reason}. Попытка ${chain.count} из ${settings.maxRetries}.`,
    recordId
  );
  await sleep(decision.delayMs);

  try {
    const result = await fillFormInTab(tabId, {});
    refillChains.set(result.recordId, chain); // новая запись наследует счётчик цепочки
    return { ok: true, action: "refilled", recordId: result.recordId, email: result.email };
  } catch (err) {
    return { ok: false, error: err?.message ?? String(err), errorType: err?.errorType ?? "unknown" };
  }
}

// Пруним цепочки, чтобы Map не рос бесконечно
setInterval(() => {
  if (refillChains.size > 20) {
    const keys = [...refillChains.keys()].slice(0, refillChains.size - 20);
    for (const k of keys) refillChains.delete(k);
  }
}, 60000).unref?.();

// ---------------------------------------------------------------------------
// Будильник: страховка сна SW для активных поллингов (фаза 5)
// ---------------------------------------------------------------------------

/** Возобновляет поллинги из storage.session (после сна/перезапуска SW). */
async function resumePolls() {
  let saved = {};
  try {
    const data = await chrome.storage.session.get(POLLS_KEY);
    saved = data?.[POLLS_KEY] ?? {};
  } catch {
    return;
  }
  for (const [recordId, info] of Object.entries(saved)) {
    if (polls.has(recordId)) continue;
    if (info.deadline <= Date.now()) continue;
    const record = await getRecord(recordId);
    if (record && [RECORD_STATUS.SUBMITTED, RECORD_STATUS.PENDING_VERIFICATION].includes(record.status)) {
      await startPolling(recordId, info.tabId, { deadline: info.deadline });
    }
  }
  if (polls.size === 0) {
    await chrome.storage.session.remove(POLLS_KEY).catch(() => {});
    chrome.alarms.clear(POLL_ALARM).catch(() => {});
  }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== POLL_ALARM) return;
  resumePolls().catch(() => {});
});

// Холодный старт SW (проснулся по сообщению/событию) — не ждём будильника
storeReady.then(() => resumePolls()).catch(() => {});

// ---------------------------------------------------------------------------
// Обработчики сообщений (протокол)
// ---------------------------------------------------------------------------

async function handleGenerateEmail(msg) {
  await storeReady;
  const { email, token, provider, attempts: failures } = await generateEmail({
    providerName: msg.providerName ?? null,
    siteDomain: msg.siteDomain ?? "",
  });
  const record = await createRecord({
    email,
    emailToken: token,
    providerName: provider.meta.id,
    domain: msg.siteDomain ?? "",
    siteName: msg.siteDomain ? "" : "Сгенерировано вручную",
    password: "",
  });
  for (const f of failures ?? []) await appendAttempt(record.id, f);
  return { email, token, providerName: provider.meta.id, recordId: record.id, record };
}

async function handleCheckInbox(msg) {
  await storeReady;
  if (!msg.recordId) throw new AppError("unknown", "Не передан recordId — непонятно, какой ящик проверять.");
  const record = await getRecord(msg.recordId);
  if (!record) throw new AppError("unknown", "Запись не найдена — возможно, она была удалена.");

  const provider = await getProviderForRecord(record);
  if (!provider) throw new AppError("provider_unavailable", `Провайдер «${record.providerName}» недоступен в этой версии расширения.`);

  const { messages, expired } = await provider.getMessages(record.emailToken);
  const parsed = parseMessages(messages);

  await updateRecord(record.id, (cur) => ({
    verification: {
      ...cur.verification,
      messageCount: messages.length,
      otpCode: parsed.code ?? cur.verification.otpCode,
      link: parsed.link ?? cur.verification.link,
    },
  }));

  // Код и ссылки отдаём popup для ручного применения (копирование/открытие)
  return { messages, expired, code: parsed.code, links: parsed.links };
}

async function handleFillForm(msg) {
  await storeReady;
  if (!msg.tabId) throw new AppError("unknown", "Не удалось определить активную вкладку.");
  return fillFormInTab(msg.tabId, { emailOnly: Boolean(msg.emailOnly), providerName: msg.providerName ?? null });
}

/**
 * v3: заполнение формы на активной вкладке данными записи журнала
 * (кнопка «Заполнить» в списке popup / экран деталей).
 */
async function handleFillRecord(msg) {
  await storeReady;
  if (!msg.recordId) throw new AppError("unknown", "Не передан recordId.");
  const record = await getRecord(msg.recordId);
  if (!record) throw new AppError("unknown", "Запись не найдена — возможно, она была удалена.");
  let tabId = msg.tabId ?? null;
  if (!tabId) {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    tabId = tab?.id ?? null;
  }
  if (!tabId) throw new AppError("unknown", "Не удалось определить активную вкладку.");

  // Если на странице форма логина — это вход; иначе дозаполнение регистрации
  let login = false;
  try {
    const inspect = await sendToTab(tabId, { type: "INSPECT_FIELDS" });
    login = inspect?.formKind === "login";
  } catch {
    /* инспекция не критична — заполняем как есть */
  }
  return fillWithRecordInTab(tabId, record, { login, banner: true });
}

/**
 * v3: content-скрипт нашёл форму логина — отдаём лучшую запись журнала
 * для этого сайта (для баннера «Войти как {email}»).
 */
async function handleLoginFormDetected(msg) {
  await storeReady;
  const settings = await getSettings();
  if (settings.loginOffer === false) return { record: null };
  const domain = String(msg.domain ?? "").toLowerCase();
  const record = await pickLoginRecord(domain);
  if (!record) return { record: null };
  return {
    record: {
      id: record.id,
      email: record.email,
      siteName: record.siteName || record.domain,
      status: record.status,
    },
  };
}

/**
 * v3: перегенерация пароля под требования нового шага многошаговой формы.
 * Обновляет запись и возвращает пароль в открытом виде (нужен для заполнения).
 */
async function handleRegeneratePassword(msg) {
  await storeReady;
  const record = await getRecord(msg.recordId);
  if (!record) throw new AppError("unknown", "Запись не найдена.");
  const req = msg.requirements ?? {};
  const { password } = generatePassword(req);
  const enc = await maybeEncrypt(password);
  await updateRecord(record.id, { password: enc.value, encrypted: enc.encrypted });
  await appendAttempt(record.id, {
    error: `пароль перегенерирован под требования шага формы (длина ${password.length})`,
    errorType: "regenerate",
    domain: emailDomainOf(record.email),
  });
  return { password };
}

async function handleUpdateRecord(msg) {
  await storeReady;
  if (!msg.recordId) throw new AppError("unknown", "Не передан recordId.");
  const patch = {};
  if (msg.patch?.notes !== undefined) patch.notes = String(msg.patch.notes).slice(0, 2000);
  if (msg.patch?.tags !== undefined) {
    patch.tags = (Array.isArray(msg.patch.tags) ? msg.patch.tags : [])
      .map((t) => String(t).trim().slice(0, 30))
      .filter(Boolean)
      .slice(0, 10);
  }
  const updated = await updateRecord(msg.recordId, patch);
  if (!updated) throw new AppError("unknown", "Запись не найдена.");
  return { record: updated };
}

async function handleGetProviders() {
  await storeReady;
  const config = await getProvidersConfig();
  const settings = await getSettings();
  return {
    strategy: settings.providerStrategy,
    builtin: listBuiltinProviders().map((p) => ({ ...p, enabled: config.builtin[p.id] !== false })),
    custom: (config.custom ?? []).map((c) => ({
      id: c.id,
      name: c.name,
      domains: Array.isArray(c.domains) ? c.domains : [],
      enabled: c.enabled !== false,
    })),
  };
}

async function handleSetProviderEnabled(msg) {
  await storeReady;
  if (!msg.id) throw new AppError("unknown", "Не передан id провайдера.");
  await setProviderEnabled(msg.id, Boolean(msg.enabled));
  await rebuildContextMenus();
  return {};
}

async function handleSaveCustomProviders(msg) {
  await storeReady;
  const custom = Array.isArray(msg.custom) ? msg.custom : [];
  // Валидируем каждый конфиг: сохраняем только целиком валидные, ошибки — списком
  const errors = [];
  const valid = [];
  for (const cfg of custom) {
    const { ok, errors: errs } = validateConfig(cfg);
    if (ok) valid.push({ ...cfg, id: cfg.id ?? customProviderId(cfg.name), enabled: cfg.enabled !== false });
    else errors.push(...errs.map((e) => `${cfg?.name ?? "конфиг"}: ${e}`));
  }
  if (errors.length > 0) {
    throw new AppError("unknown", `Конфиги с ошибками не сохранены:\n${errors.join("\n")}`);
  }
  await saveCustomProviders(valid);
  await rebuildContextMenus();
  return {};
}

async function handleTestCustomProvider(msg) {
  await storeReady;
  const { ok, errors } = validateConfig(msg.config);
  if (!ok) throw new AppError("unknown", errors.join("; "));
  const provider = createCustomProvider(msg.config);
  const { email, token } = await provider.createInbox();
  // Сразу проверяем чтение писем — чтобы юзер видел рабочий цикл целиком
  let messages = [];
  try {
    ({ messages } = await provider.getMessages(token));
  } catch {
    // чтение не удалось — сообщим отдельно, но inbox создан
  }
  return { email, messagesCount: messages.length };
}

/** v3: единый bootstrap-запрос для popup (порт GET_STATE из v2). */
async function handleGetState() {
  await storeReady;
  const [records, settings, providers] = await Promise.all([getRecords(), getSettings(), handleGetProviders()]);
  const meta = await getCryptoMeta();
  const master = await getSessionMaster();
  return {
    records,
    settings,
    providers,
    crypto: { enabled: meta.enabled === true, unlocked: Boolean(master) },
  };
}

// --- Шифрование: обработчики (v3, порт из v2) --------------------------------

async function handleCryptoSetup(msg) {
  await storeReady;
  const password = String(msg.password ?? "");
  if (password.length < 4) throw new AppError("unknown", "Мастер-пароль слишком короткий (минимум 4 символа).");
  const salt = crypto.newSalt();
  const key = await crypto.deriveKey(password, salt);
  const verifier = await crypto.makeVerifier(key);
  await setCryptoMeta({ enabled: true, salt, verifier });
  await setSessionMaster(password);
  await encryptAllExisting(key);
  await saveSettings({ encryptionEnabled: true });
  return {};
}

async function handleCryptoUnlock(msg) {
  await storeReady;
  const meta = await getCryptoMeta();
  if (!meta.enabled) throw new AppError("unknown", "Шифрование не включено.");
  const key = await crypto.deriveKey(String(msg.password ?? ""), meta.salt);
  if (!(await crypto.checkVerifier(key, meta.verifier))) {
    throw new AppError("unknown", "Неверный мастер-пароль.");
  }
  await setSessionMaster(String(msg.password ?? ""));
  return {};
}

async function handleCryptoLock() {
  await storeReady;
  await clearSessionMaster();
  return {};
}

async function handleCryptoDisable(msg) {
  await storeReady;
  const meta = await getCryptoMeta();
  if (meta.enabled) {
    const key = await crypto.deriveKey(String(msg.password ?? ""), meta.salt);
    if (!(await crypto.checkVerifier(key, meta.verifier))) {
      throw new AppError("unknown", "Неверный мастер-пароль.");
    }
    await decryptAllExisting(key);
  }
  await clearCryptoMeta();
  await clearSessionMaster();
  await saveSettings({ encryptionEnabled: false });
  return {};
}

/** v3: пароль записи для popup (глазок/копирование) — с учётом шифра. */
async function handleDecryptPassword(msg) {
  await storeReady;
  const record = await getRecord(msg.recordId);
  if (!record) throw new AppError("unknown", "Запись не найдена.");
  if (!crypto.isEncrypted(record.password)) return { password: record.password };
  const key = await deriveSessionKey();
  if (!key) return { locked: true };
  try {
    return { password: await crypto.decryptString(key, record.password) };
  } catch {
    return { locked: true };
  }
}

const handlers = {
  // --- от popup/options ---
  GET_STATE: handleGetState,
  GENERATE_EMAIL: handleGenerateEmail,
  CHECK_INBOX: handleCheckInbox,
  FILL_FORM: handleFillForm,
  FILL_RECORD: handleFillRecord,
  GET_RECORDS: async () => ({ records: await getRecords() }),
  GET_RECORD: async (msg) => {
    const record = await getRecord(msg.recordId);
    if (!record) throw new AppError("unknown", "Запись не найдена.");
    return { record };
  },
  DELETE_RECORD: async (msg) => {
    await storeReady;
    if (!msg.recordId) throw new AppError("unknown", "Не передан recordId.");
    await stopPolling(msg.recordId);
    await deleteRecord(msg.recordId);
    return {};
  },
  UPDATE_RECORD: handleUpdateRecord,
  GET_SETTINGS: async () => ({ settings: await getSettings() }),
  SAVE_SETTINGS: async (msg) => ({ settings: await saveSettings(msg.settings ?? {}) }),
  GET_PROVIDERS: handleGetProviders,
  SET_PROVIDER_ENABLED: handleSetProviderEnabled,
  SAVE_CUSTOM_PROVIDERS: handleSaveCustomProviders,
  TEST_CUSTOM_PROVIDER: handleTestCustomProvider,
  OPEN_LINK: async (msg) => {
    if (!msg.url || !/^https?:\/\//i.test(msg.url)) throw new AppError("unknown", "Некорректная ссылка.");
    await openVerificationLink(msg.url, msg.recordId ?? null);
    return { opened: true };
  },

  // --- шифрование (v3) ---
  CRYPTO_STATUS: async () => {
    await storeReady;
    const meta = await getCryptoMeta();
    return { enabled: meta.enabled === true, unlocked: Boolean(await getSessionMaster()) };
  },
  CRYPTO_SETUP: handleCryptoSetup,
  CRYPTO_UNLOCK: handleCryptoUnlock,
  CRYPTO_LOCK: handleCryptoLock,
  CRYPTO_DISABLE: handleCryptoDisable,
  DECRYPT_PASSWORD: handleDecryptPassword,

  // --- от контента ---
  FORM_DETECTED: async (msg, sender) => {
    if (sender.tab?.id != null) await setFormBadge(sender.tab.id, Boolean(msg.hasForm));
    return {};
  },
  RUN_FILL: async (msg, sender) => {
    // Инлайн-кнопка: sender.tab.id — вкладка с полем
    return fillFormInTab(sender.tab?.id, { emailOnly: Boolean(msg.emailOnly) });
  },
  LOGIN_FORM_DETECTED: handleLoginFormDetected,
  RUN_LOGIN_FILL: async (msg, sender) => {
    await storeReady;
    const record = await getRecord(msg.recordId);
    if (!record) return { ok: true, ignored: true };
    // Баннер входа может жить в ФОНОВОЙ вкладке (ссылка подтверждения) —
    // вкладку берём от отправителя, а не от «активной»
    let tabId = sender?.tab?.id ?? null;
    if (tabId == null) {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      tabId = tab?.id ?? null;
    }
    if (!tabId) throw new AppError("unknown", "Не удалось определить вкладку.");
    return fillWithRecordInTab(tabId, record, { login: true, banner: true });
  },
  REGENERATE_PASSWORD: handleRegeneratePassword,
  STEP_FILLED: async (msg, sender) => {
    // Content-сессия дозаполнила поля следующего шага многошаговой формы
    await storeReady;
    const record = await getRecord(msg.recordId);
    if (!record) return { ok: true, ignored: true };
    const total = Number(msg.filled?.total) || 0;
    await appendAttempt(record.id, {
      error: `шаг формы: дозаполнено полей — ${total}`,
      errorType: "step",
      domain: emailDomainOf(record.email),
    });
    // Письмо придёт только после последнего шага — отодвигаем дедлайн поллинга
    const poll = polls.get(record.id);
    if (poll) {
      const settings = await getSettings();
      poll.deadline = Date.now() + Math.max(Number(settings.pollingTimeoutMs) || 300000, 15000);
      await persistPolls();
    }
    if (sender?.tab?.id != null) {
      await sendToTab(sender.tab.id, {
        type: "SHOW_BANNER",
        text: `Следующий шаг заполнен (${total} полей).`,
        autoHideMs: 4000,
      }).catch(() => {});
    }
    return {};
  },
  SUBMITTED: async (msg, sender) => {
    await storeReady;
    const record = await getRecord(msg.recordId);
    if (!record) return { ok: true, ignored: true };
    // Повторный сабмит (шаг 2 многошаговой формы) не откатывает статус назад
    if (![RECORD_STATUS.PENDING_VERIFICATION, RECORD_STATUS.VERIFIED].includes(record.status)) {
      await setStatus(record.id, RECORD_STATUS.SUBMITTED);
    }
    await startPolling(record.id, sender.tab?.id ?? msg.tabId ?? null);
    return {};
  },
  ERROR_SUBMITTED: async (msg, sender) => {
    await storeReady;
    return handleSubmittedError(msg.recordId, msg.pageText ?? "", sender.tab?.id ?? null);
  },
  PAGE_VERIFIED: async (msg) => {
    await storeReady;
    const record = await getRecord(msg.recordId);
    if (!record) return { ok: true, ignored: true };
    await setStatus(record.id, RECORD_STATUS.VERIFIED);
    await stopPolling(record.id);
    await notify("AutoReg: регистрация завершена", `Аккаунт на ${record.domain || "сайте"} подтверждён.`, record.id);
    return {};
  },
};

// ---------------------------------------------------------------------------
// Роутер сообщений
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const handler = handlers[msg?.type];
  if (!handler) {
    sendResponse({
      ok: false,
      error: `Неизвестный тип сообщения: ${msg?.type ?? "(пусто)"}`,
      errorType: "unknown",
    });
    return false;
  }
  handler(msg, _sender)
    .then((data) => sendResponse({ ok: true, ...data }))
    .catch((err) => {
      // ProviderError/AppError несут errorType; прочее классифицируем как unknown
      sendResponse({ ok: false, error: err?.message || String(err), errorType: err?.errorType || "unknown" });
    });
  return true; // ответ асинхронный — канал остаётся открытым
});
