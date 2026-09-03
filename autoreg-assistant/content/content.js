/**
 * AutoReg Assistant — content script v3 (классический вход, НЕ module:
 * content_scripts в MV3 не бывают ES-модулями).
 *
 * Обязанности:
 *  - маршрутизатор сообщений background/popup → модули (dynamic import);
 *  - INSPECT_FIELDS / FILL_FIELDS (+ вид формы login/signup);
 *  - v3 МНОГОШАГОВЫЕ ФОРМЫ: после заполнения — сессия-наблюдатель; новые
 *    пустые поля пароля (шаг 2 формы) автоматически получают те же данные,
 *    при более строгих требованиях — перегенерация пароля через SW;
 *  - v3 ЛОГИН: детект формы входа → LOGIN_FORM_DETECTED → баннер «Войти
 *    как {email}» из журнала (без создания новой регистрации);
 *  - детект сабмита (фазы 5): submit/исчезновение формы/поля OTP/тексты
 *    успеха → SUBMITTED; ошибки → ERROR_SUBMITTED; успех → PAGE_VERIFIED;
 *  - v3 OTP: pending-код вставляется при появлении поля; после вставки —
 *    авто-нажатие кнопки подтверждения (настройка otpAutoConfirm);
 *  - отчёт FORM_DETECTED для badge на иконке.
 *
 * UI на странице (баннер, инлайн-кнопка) — только через Shadow DOM.
 */

(() => {
  // Защита от повторной инжекции (manifest + scripting.executeScript fallback)
  if (window.__autoRegAssistantLoaded) return;
  window.__autoRegAssistantLoaded = true;

  const getURL = (p) => chrome.runtime.getURL(p);

  // Модули грузятся один раз; промисы кэшируются — слушатель ниже синхронный
  const modules = {
    formFiller: import(getURL("core/form-filler.js")),
    classifier: import(getURL("core/error-classifier.js")),
    otp: import(getURL("content/otp-autofill.js")),
    banner: import(getURL("content/page-banner.js")),
    inline: import(getURL("content/inline-button.js")), // сам сканирует поля и ставит кнопки
    generator: import(getURL("core/password-generator.js")),
  };

  /** Отправка в background без падения при инвалидированном контексте. */
  function sendToBackground(msg) {
    try {
      return chrome.runtime.sendMessage(msg).catch(() => null);
    } catch {
      return Promise.resolve(null);
    }
  }

  function debounce(fn, ms) {
    let t;
    return (...a) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...a), ms);
    };
  }

  // ---------------------------------------------------------------------------
  // v3: сессия заполнения — многошаговые формы (шаг 1 email → шаг 2 пароль)
  // ---------------------------------------------------------------------------

  /**
   * fillSession: {recordId, identity, fillMode, autoSubmit, expiresAt, mo}
   * Живёт до: PAGE_VERIFIED / ERROR_SUBMITTED / навигации / 10 минут.
   */
  let fillSession = null;

  function stopFillSession() {
    if (!fillSession) return;
    if (fillSession.mo) fillSession.mo.disconnect();
    if (fillSession.timer) clearTimeout(fillSession.timer);
    fillSession = null;
  }

  function startFillSession(recordId, identity, { fillMode, autoSubmit }) {
    stopFillSession();
    fillSession = {
      recordId,
      identity: { ...identity },
      fillMode,
      autoSubmit,
      expiresAt: Date.now() + 10 * 60 * 1000,
      mo: null,
      timer: null,
    };
    // Шаг 2 может появиться как новые узлы (SPA) или как снятие hidden/display:none
    // с уже существующей формы — следим и за атрибутами
    fillSession.mo = new MutationObserver(debounce(onStepMutation, 700));
    fillSession.mo.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["hidden", "style", "class", "disabled", "type", "aria-hidden"],
    });
    fillSession.timer = setTimeout(stopFillSession, 10 * 60 * 1000 + 1000);
  }

  /** Новые пустые поля шага 2+ — заполняем теми же данными. */
  async function onStepMutation() {
    if (!fillSession || Date.now() > fillSession.expiresAt) {
      stopFillSession();
      return;
    }
    const ff = await modules.formFiller;
    const fields = ff.detectFields();
    const result = ff.fillEmptyFields(fields, fillSession.identity, { fillMode: fillSession.fillMode });
    if (result.total === 0) return;

    // Появились password-поля с более строгими требованиями → перегенерация
    if (result.password > 0 && result.requirements) {
      const gen = await modules.generator;
      const ok = gen.meetsTextRequirements(fillSession.identity.password, result.requirements.textHint)
        && (!result.requirements.minLength || fillSession.identity.password.length >= result.requirements.minLength)
        && (!result.requirements.maxLength || fillSession.identity.password.length <= result.requirements.maxLength)
        && (!result.requirements.pattern || (() => {
          try { return new RegExp("^(?:" + result.requirements.pattern + ")$").test(fillSession.identity.password); }
          catch { return true; }
        })());
      if (!ok) {
        const resp = await sendToBackground({
          type: "REGENERATE_PASSWORD",
          recordId: fillSession.recordId,
          requirements: result.requirements,
        });
        if (resp?.ok && resp.password) {
          fillSession.identity.password = resp.password;
          // перезаполняем все password/confirm текущего шага новым паролем
          for (const input of [...fields.password, ...fields.confirm]) {
            if (result.filledInputs.has(input) || (input.value ?? "") === "") {
              ff.fillInput(input, resp.password);
            }
          }
        }
      }
      // Пароль появился только сейчас (шаг 1 был без него): запись ещё в
      // статусе «только email» — сообщаем фону, что форма заполнена целиком
      sendToBackground({ type: "STEP_FILLED", recordId: fillSession.recordId, filled: result });
    }

    // Новый шаг = новая форма: наблюдение за сабмитом переводим на неё,
    // иначе SUBMITTED сработает по форме шага 1 и поллинг стартует рано
    if (!watch || watch.finished || !watch.formEl?.isConnected) {
      startSubmitWatch(fillSession.recordId, fields);
    }
    if (fillSession.autoSubmit) scheduleAutoSubmit(fields);
  }

  // ---------------------------------------------------------------------------
  // v3: детект формы логина → предложение входа с сохранёнными данными
  // ---------------------------------------------------------------------------

  let loginOfferShown = false; // один баннер на страницу
  let lastKindReported = null;

  /** Проверяет форму; если это логин и есть записи — просит показать баннер. */
  async function maybeOfferLogin() {
    if (loginOfferShown) return;
    const ff = await modules.formFiller;
    const fields = ff.detectFields();
    if (fields.email.length === 0) return; // не логин и не регистрация
    const kind = ff.detectFormKind(fields);
    const key = kind + "|" + location.pathname;
    if (key === lastKindReported) return;
    lastKindReported = key;
    if (kind !== "login") return;

    // спрашиваем background: есть ли запись для этого сайта
    const resp = await sendToBackground({
      type: "LOGIN_FORM_DETECTED",
      domain: location.hostname,
      url: location.href,
      title: document.title,
    });
    if (resp?.ok && resp.record) {
      loginOfferShown = true;
      const banner = await modules.banner;
      banner.showLoginOffer({ email: resp.record.email, recordId: resp.record.id, siteName: resp.record.siteName });
    }
  }

  // ---------------------------------------------------------------------------
  // Детект сабмита и ошибок после заполнения (фазы 5–6)
  // ---------------------------------------------------------------------------

  const WEAK_SUCCESS_RE = /(проверьте\s+(вашу\s+)?(почту|email)|check\s+your\s+(e-?mail|inbox)|verify\s+your\s+(e-?mail|account)|подтверд(ите|ите\s+email)|confirm\s+your\s+(e-?mail|account)|we\s+(have\s+)?sent\s+(you\s+)?(an?\s+)?(e-?mail|код|code))/i;
  const STRONG_SUCCESS_RE = /(регистрац\w*\s+(успешн|заверш)|вы\s+зарегистрирован|аккаунт\s+создан|account\s+(has\s+been\s+)?(created|activated)|registration\s+(complete|successful)|successfully\s+registered|you\s+are\s+(now\s+)?(logged|signed)\s+in|вход\s+выполнен|добро\s+пожаловать)/i;
  const GENERIC_ERROR_RE = /(ошибк|error|не\s*удалось|failed|try\s+again|повторите\s+позже)/i;

  let watch = null; // {recordId, formEl, emailField, submitted, finished, timer, mo, submitHandler}

  function stopWatch() {
    if (!watch) return;
    if (watch.timer) clearTimeout(watch.timer);
    if (watch.mo) watch.mo.disconnect();
    if (watch.submitHandler) document.removeEventListener("submit", watch.submitHandler, true);
    watch = null;
  }

  /** Запуск наблюдения после заполнения полей. */
  function startSubmitWatch(recordId, fields) {
    stopWatch();
    if (!recordId) return;
    const formEl = fields.email[0]?.closest?.("form") ?? fields.password[0]?.closest?.("form") ?? null;
    watch = {
      recordId,
      formEl,
      emailField: fields.email[0] ?? null,
      submitted: false,
      finished: false,
      startedAt: Date.now(),
    };

    // Сабмит: захватываем на document — форма может перерисоваться, но
    // событие всплывёт до document в фазе захвата в любом случае
    watch.submitHandler = (event) => {
      if (!watch || watch.submitted) return;
      const target = event.target;
      const related = !watch.formEl || target === watch.formEl || (watch.emailField && target?.contains?.(watch.emailField));
      if (!related) return; // пользователь сабмитит другую форму (например, логин)
      setTimeout(markSubmitted, 1200); // даём странице отреагировать
    };
    document.addEventListener("submit", watch.submitHandler, true);

    // SPA-сигналы: исчезновение формы, поля OTP, тексты успеха/ошибки
    let scanTimer = null;
    watch.mo = new MutationObserver(() => {
      if (scanTimer) clearTimeout(scanTimer);
      scanTimer = setTimeout(scanSignals, 900);
    });
    watch.mo.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["hidden", "style", "class", "aria-hidden"],
    });

    watch.timer = setTimeout(stopWatch, 180000); // максимум 3 минуты наблюдения
    setTimeout(scanSignals, 1500); // первичная проверка
  }

  function markSubmitted() {
    if (!watch || watch.submitted) return;
    watch.submitted = true;
    sendToBackground({ type: "SUBMITTED", recordId: watch.recordId });
  }

  /** Один проход по сигналам страницы. */
  async function scanSignals() {
    if (!watch || watch.finished) return;
    bodyTextCache = null; // текст страницы меняется — пересобираем
    const classifier = await modules.classifier;
    const otp = await modules.otp;

    const otpFields = otp.findOtpFields();
    const formGone = watch.formEl ? !watch.formEl.isConnected : false;

    if (!watch.submitted) {
      if (otpFields.any || formGone || pageTextMatches(WEAK_SUCCESS_RE)) {
        markSubmitted();
      }
      return;
    }

    // После сабмита: ищем ошибки и сильный успех
    if (pageTextMatches(STRONG_SUCCESS_RE)) {
      watch.finished = true;
      sendToBackground({ type: "PAGE_VERIFIED", recordId: watch.recordId });
      stopWatch();
      stopFillSession();
      return;
    }

    const errorText = collectErrorTexts();
    if (errorText && (classifier.classifyPageText(errorText) || GENERIC_ERROR_RE.test(errorText))) {
      watch.finished = true;
      sendToBackground({ type: "ERROR_SUBMITTED", recordId: watch.recordId, pageText: errorText.slice(0, 600) });
      // Наблюдение остановлено: дальнейшие решения принимает background (ретраи);
      // сессия шагов тоже закрывается — иначе она дозаполнит форму старым email
      stopWatch();
      stopFillSession();
    }
  }

  /** Видимый текст страницы (кэш на проход — innerText дорогой). */
  let bodyTextCache = null;
  function pageText() {
    if (bodyTextCache === null) bodyTextCache = (document.body?.innerText ?? "").slice(0, 5000);
    return bodyTextCache;
  }
  function pageTextMatches(re) {
    try {
      return re.test(pageText());
    } catch {
      return false;
    }
  }

  /** Тексты из типовых контейнеров ошибок (alert'ы, подсказки форм). */
  function collectErrorTexts() {
    const selectors = '[role="alert"], [class*="error" i], [class*="alert" i], [class*="warning" i], [class*="invalid" i], [class*="danger" i]';
    const parts = [];
    try {
      for (const el of document.querySelectorAll(selectors)) {
        if (parts.length >= 25) break;
        const rect = el.getBoundingClientRect?.();
        if (rect && (rect.width === 0 || rect.height === 0)) continue; // скрытые
        const text = (el.textContent ?? "").trim();
        if (text && text.length < 400 && !parts.includes(text)) parts.push(text);
      }
    } catch {
      /* выборка безопасна */
    }
    return parts.join("\n");
  }

  /** Авто-сабмит (настройка autoSubmit): жмём форму после заполнения. */
  function scheduleAutoSubmit(fields) {
    setTimeout(() => {
      const form = fields.email[0]?.closest?.("form") ?? fields.password[0]?.closest?.("form");
      if (!form || !form.isConnected) return;
      try {
        if (typeof form.requestSubmit === "function") form.requestSubmit();
        else form.submit();
      } catch {
        // fallback: кнопка сабмита
        form.querySelector?.('[type="submit"]:not(:disabled)')?.click?.();
      }
    }, 400);
  }

  // ---------------------------------------------------------------------------
  // v3: OTP pending — вставить код, как только поле появится
  // ---------------------------------------------------------------------------

  const otpPendingScan = debounce(async () => {
    const otp = await modules.otp;
    if (!otp.getPendingCode()) return;
    const settings = await getSettingsCached();
    const result = otp.tryPending({ autoConfirm: settings.otpAutoConfirm !== false });
    if (result.applied) {
      const banner = await modules.banner;
      if (result.confirmed) {
        banner.showBanner({ text: `Код подтверждения вставлен, подтверждение отправлено.`, autoHideMs: 5000 });
      } else {
        banner.showBanner({ text: "Код подтверждения вставлен в поле.", autoHideMs: 5000 });
      }
    }
  }, 600);

  new MutationObserver(otpPendingScan).observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["hidden", "style", "class", "aria-hidden"],
  });

  let settingsCache = null;
  async function getSettingsCached() {
    if (settingsCache) return settingsCache;
    const resp = await sendToBackground({ type: "GET_SETTINGS" });
    settingsCache = resp?.ok ? resp.settings ?? {} : {};
    return settingsCache;
  }

  // ---------------------------------------------------------------------------
  // Отчёт о наличии формы для badge (фаза 3) + v3 логин-предложение
  // ---------------------------------------------------------------------------

  let lastReported = null;
  async function reportFormStatus() {
    const ff = await modules.formFiller;
    const fields = ff.detectFields();
    const found = ff.hasFillableForm(fields);
    if (found === lastReported) return;
    lastReported = found;
    sendToBackground({ type: "FORM_DETECTED", hasForm: found });
    if (found) {
      // v3: на форме логина предлагаем вход с сохранёнными данными
      maybeOfferLogin().catch(() => {});
    }
  }

  const debouncedReport = (() => {
    let timer;
    return () => {
      clearTimeout(timer);
      timer = setTimeout(reportFormStatus, 700);
    };
  })();

  new MutationObserver(debouncedReport).observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["hidden", "style", "class", "type"],
  });
  reportFormStatus();

  // ---------------------------------------------------------------------------
  // Маршрутизатор сообщений
  // ---------------------------------------------------------------------------

  async function route(msg) {
    switch (msg?.type) {
      case "INSPECT_FIELDS": {
        const ff = await modules.formFiller;
        const fields = ff.detectFields();
        return {
          hasForm: ff.hasFillableForm(fields),
          emailOnlyStep: ff.isEmailFirstStep(fields),
          formKind: ff.detectFormKind(fields),
          counts: {
            email: fields.email.length,
            password: fields.password.length,
            confirm: fields.confirm.length,
            username: fields.username.length,
          },
          requirements: ff.fieldRequirements(fields),
          url: location.href,
          title: document.title,
          domain: location.hostname,
        };
      }
      case "FILL_FIELDS": {
        const ff = await modules.formFiller;
        const fields = ff.detectFields();
        const filled = ff.fillFields(fields, msg.identity, { fillMode: msg.fillMode });
        if (filled.total > 0 && msg.watch !== false) {
          startSubmitWatch(msg.recordId, fields);
          // v3: сессия для многошаговых форм (настройка autofillSteps).
          // Для «только email» сессия не нужна: пароль пользователь вводит сам.
          const settings = await getSettingsCached();
          if (settings.autofillSteps !== false && msg.fillMode !== "email") {
            startFillSession(msg.recordId, msg.identity, { fillMode: msg.fillMode, autoSubmit: msg.autoSubmit });
          } else {
            stopFillSession();
          }
          if (msg.autoSubmit) scheduleAutoSubmit(fields);
        }
        return { filled, url: location.href, title: document.title, domain: location.hostname };
      }
      case "FILL_OTP": {
        const otp = await modules.otp;
        const result = otp.fillOtp({ code: msg.code, autoConfirm: msg.autoConfirm !== false });
        if (!result.applied) {
          // Поле ещё не появилось (многошаговый процесс) — запоминаем код
          otp.setPendingCode(msg.code);
          const banner = await modules.banner;
          banner.showCode(msg.code);
        }
        return result;
      }
      case "SHOW_BANNER": {
        const banner = await modules.banner;
        return { shown: banner.showBanner(msg) };
      }
      case "SHOW_CODE": {
        const banner = await modules.banner;
        return { shown: banner.showCode(msg.code) };
      }
      case "GET_FORM_STATUS": {
        const ff = await modules.formFiller;
        const fields = ff.detectFields();
        return {
          found: ff.hasFillableForm(fields),
          formKind: ff.detectFormKind(fields),
          hasEmail: fields.email.length > 0,
          url: location.href,
          title: document.title,
          domain: location.hostname,
        };
      }
      default:
        return { __unknown: true };
    }
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    route(msg)
      .then((result) => sendResponse(result ?? {}))
      .catch((err) => sendResponse({ ok: false, error: String(err?.message ?? err) }));
    return true; // ответ асинхронный
  });
})();
