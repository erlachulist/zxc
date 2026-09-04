/**
 * AutoReg Assistant — поиск и заполнение полей форм регистрации (v3).
 *
 * Модуль используется двумя сторонами:
 *  - content/content.js (dynamic import) — детект полей и заполнение в DOM страницы;
 *  - background/service-worker.js — НЕТ (DOM там недоступен; требования полей
 *    background получает от контента сообщением INSPECT_FIELDS).
 *
 * v3: детект ВИДА формы (login | signup | unknown) для сценария «войти с
 * сохранёнными данными», сбор текстовых требований к паролю, заполнение
 * только пустых полей (многошаговые формы).
 *
 * Заполнение: value через нативный сеттер прототипа + dispatch input и change
 * (иначе React/Vue не видят изменение), плюс focus/blur для валидаторов форм.
 */

// --- Эвристики распознавания (латиница + кириллица, из проверенного прототипа v1) ---

const EMAIL_RE = /(e[-_]?mail|mail|почт|электрон)/i;
const USERNAME_RE = /(user[-_]?name|login|nick|логин|никнейм|псевдоним)/i;
const CONFIRM_RE = /(confirm|repeat|again|re[-_]?type|re[-_]?enter|re[-_]?pass|verify|подтвер|повтор|ещ[ёе] раз)/i;
// «2» как признак повтора: password2 / pass-2 / pwd_2 (фаза 3: confirm… «2»)
const CONFIRM2_RE = /(?:pass(word)?|pwd)[-_]?2\b/i;

/** Сильные сигналы формы входа (вес 2 — заголовки, url, кнопки). */
const LOGIN_STRONG_RE = /\b(log[-\s]?in|sign[-\s]?in|войти|вход\b|авторизац)/i;
/** Сильные сигналы формы регистрации (вес 2). */
const SIGNUP_STRONG_RE = /\b(sign[-\s]?up|create\s+(an?\s+)?account|register|регистрац|зарегистр|созда(ть|ние)\s+аккаунт)/i;
/** Слабые сигналы (вес 1 — ссылки «Don't have an account?»). */
const LOGIN_WEAK_RE = /\b(log[-\s]?in|sign[-\s]?in|войти)\b/i;
const SIGNUP_WEAK_RE = /\b(sign[-\s]?up|create\s+(an?\s+)?account|зарегистр)/i;

/** Все текстовые признаки поля: name, id, placeholder, autocomplete, aria-label, label. */
export function attrText(input) {
  const parts = [
    input.name,
    input.id,
    input.getAttribute?.("placeholder"),
    input.getAttribute?.("autocomplete"),
    input.getAttribute?.("aria-label"),
    input.getAttribute?.("data-testid"),
    typeof input.className === "string" ? input.className : "",
  ];
  // input.labels существует только в браузере; в тестах его нет
  if (input.labels) {
    for (const label of input.labels) parts.push(label.textContent);
  }
  const wrapper = input.closest?.("label");
  if (wrapper) parts.push((wrapper.textContent || "").slice(0, 80));
  return parts.filter(Boolean).join(" ").toLowerCase();
}

/** Поле видно и доступно для ввода. */
export function isFillable(input) {
  const type = (input.getAttribute?.("type") || input.type || "text").toLowerCase();
  if (!["text", "email", "password", "tel", "", "number"].includes(type)) return false;
  if (input.disabled || input.readOnly) return false;
  // getClientRects есть только в браузере; в тестах считаем поле видимым
  if (input.getClientRects && input.getClientRects().length === 0) return false;
  return true;
}

/** Классификация: email | username | password | confirm | null. */
export function classify(input) {
  const type = (input.getAttribute?.("type") || input.type || "text").toLowerCase();
  if (type === "password") {
    const text = attrText(input);
    return CONFIRM_RE.test(text) || CONFIRM2_RE.test((input.name || "") + " " + (input.id || "")) ? "confirm" : "password";
  }
  const text = attrText(input);
  if (type === "email" || input.getAttribute?.("autocomplete") === "email" || EMAIL_RE.test(text)) return "email";
  if (USERNAME_RE.test(text)) return "username";
  return null;
}

/**
 * Собирает поля формы на странице.
 * @param {Document|Element} [root] — по умолчанию document.
 * @returns {{email: Array, password: Array, confirm: Array, username: Array}}
 */
export function detectFields(root) {
  const doc = root ?? (typeof document !== "undefined" ? document : null);
  if (!doc?.querySelectorAll) return { email: [], password: [], confirm: [], username: [] };
  const fields = { email: [], password: [], confirm: [], username: [] };
  for (const input of doc.querySelectorAll("input")) {
    if (!isFillable(input)) continue;
    const kind = classify(input);
    if (kind) fields[kind].push(input);
  }
  // Два password подряд без пометки повтора → второй считаем confirm
  if (fields.password.length === 2 && fields.confirm.length === 0) {
    fields.confirm.push(fields.password.pop());
  }
  return fields;
}

/** Есть ли на странице форма регистрации (эвристика из v1). */
export function hasRegistrationForm(fields) {
  const f = fields ?? detectFields();
  const passwordCount = f.password.length + f.confirm.length;
  return (f.email.length > 0 && passwordCount > 0) || f.confirm.length > 0 || passwordCount >= 2;
}

/**
 * Форма, которую имеет смысл заполнять: полная регистрация ИЛИ первый шаг
 * многошаговой («введите email» без пароля — пароль спросят на шаге 2).
 * Одинокое email-поле подписки/поиска отсекаем по контексту: нужна кнопка
 * сабмита в той же форме и сигналы регистрации/продолжения вокруг.
 */
export function hasFillableForm(fields) {
  const f = fields ?? detectFields();
  if (hasRegistrationForm(f)) return true;
  return isEmailFirstStep(f);
}

const STEP_BTN_RE = /(continue|next|proceed|get\s+started|sign\s?up|register|create|join|далее|продолж|регистр|созда|начать|присоедин)/i;
const NEWSLETTER_RE = /(subscribe|newsletter|подпис|рассылк|search|поиск)/i;

/** Шаг 1 многошаговой регистрации: email без пароля + кнопка «Continue/Sign up». */
export function isEmailFirstStep(fields) {
  const f = fields ?? detectFields();
  if (f.email.length === 0 || f.password.length + f.confirm.length > 0) return false;
  const email = f.email[0];
  const form = email.closest?.("form");
  const scope = form ?? email.closest?.("div,section,main") ?? null;
  if (!scope) return false;
  const scopeText = String(scope.textContent ?? "").slice(0, 600);
  if (NEWSLETTER_RE.test(scopeText) && !SIGNUP_STRONG_RE.test(scopeText)) return false;
  // «Войти по email» / «восстановить пароль» — не регистрация
  const pageHint = `${typeof document !== "undefined" ? document.title : ""} ${typeof location !== "undefined" ? location.pathname.replace(/[/_.-]+/g, " ") : ""}`;
  const heading = typeof document !== "undefined" ? (document.querySelector("h1, h2, [role=heading]")?.textContent ?? "") : "";
  const strong = `${pageHint} ${heading} ${scopeText}`;
  if (/(forgot|reset|восстанов|забыл)/i.test(strong)) return false;
  if (LOGIN_STRONG_RE.test(strong) && !SIGNUP_STRONG_RE.test(strong)) return false;
  const btn = scope.querySelector?.('button, input[type="submit"], [role="button"]');
  const btnText = btn ? String(btn.textContent || btn.value || "") : "";
  if (btn && STEP_BTN_RE.test(btnText)) return true;
  // Кнопки нет/без текста — доверяем заголовку страницы и URL
  return SIGNUP_STRONG_RE.test(pageHint);
}

/**
 * Вид формы: "signup" | "login" | "unknown" (v3 — сценарий входа с данными).
 *
 * Сигналы с весом 2: <title>, URL-путь, заголовки h1–h3, текст кнопки сабмита.
 * Сигналы с весом 1: остальной видимый текст (ссылки «Sign Up» и т.п.).
 * Наличие confirm-поля — решающий голос за "signup".
 */
export function detectFormKind(fields) {
  const f = fields ?? detectFields();
  if (f.confirm.length > 0) return "signup";

  const strongText = [];
  try {
    if (typeof document !== "undefined") {
      if (document.title) strongText.push(document.title);
      const path = location.pathname || "";
      strongText.push(path.replace(/[/_.-]+/g, " "));
      for (const h of document.querySelectorAll("h1, h2, h3, [role=heading]")) {
        strongText.push((h.textContent || "").trim());
        if (strongText.length > 24) break;
      }
      // текст кнопки сабмита
      const btn = document.querySelector('button[type="submit"], input[type="submit"], form button:not([type])');
      if (btn) strongText.push((btn.textContent || btn.value || "").trim());
    }
  } catch {
    /* окружение без document (тесты) */
  }
  const strong = strongText.join(" ").slice(0, 400);
  const weak = typeof document !== "undefined" && document.body?.innerText
    ? String(document.body.innerText).slice(0, 2000)
    : "";

  let loginScore = (strong.match(new RegExp(LOGIN_STRONG_RE.source, "gi")) ?? []).length * 2
    + (weak.match(new RegExp(LOGIN_WEAK_RE.source, "gi")) ?? []).length;
  let signupScore = (strong.match(new RegExp(SIGNUP_STRONG_RE.source, "gi")) ?? []).length * 2
    + (weak.match(new RegExp(SIGNUP_WEAK_RE.source, "gi")) ?? []).length;

  const passwordCount = f.password.length + f.confirm.length;
  // email + ровно один пароль без явных сигналов регистрации → похоже на логин
  if (loginScore === 0 && signupScore === 0 && f.email.length > 0 && passwordCount === 1) {
    loginScore = 1;
  }
  if (loginScore > signupScore) return "login";
  if (signupScore > loginScore) return "signup";
  return "unknown";
}

/** Численно: parseInt атрибута или 0. */
function numAttr(input, name) {
  const v = parseInt(input.getAttribute?.(name) ?? "", 10);
  return Number.isFinite(v) && v > 0 ? v : 0;
}

/** Текст требований рядом с полями пароля (для password-generator). */
export function passwordHintText(fields) {
  const f = fields ?? detectFields();
  const sources = [];
  for (const input of [...f.password, ...f.confirm].slice(0, 2)) {
    // ближайшая форма или контейнер
    const scope = input.closest?.("form") ?? input.closest?.("div,section,fieldset") ?? input.parentElement;
    if (scope) sources.push((scope.textContent || "").replace(/\s+/g, " ").slice(0, 600));
  }
  return sources.join(" ").toLowerCase();
}

/**
 * Требования к паролю со стороны формы (для background/INSPECT_FIELDS):
 * minlength/maxlength поля пароля, pattern, отдельный maxlength повтора,
 * текст требований рядом с формой.
 */
export function fieldRequirements(fields) {
  const f = fields ?? detectFields();
  const pw = f.password[0];
  const confirm = f.confirm[0];
  return {
    minLength: pw ? numAttr(pw, "minlength") : 0,
    maxLength: pw ? numAttr(pw, "maxlength") : 0,
    confirmMaxLength: confirm ? numAttr(confirm, "maxlength") : 0,
    pattern: pw ? (pw.getAttribute?.("pattern") || null) : null,
    textHint: passwordHintText(f),
  };
}

// --- Заполнение ---

/**
 * Устанавливает value через нативный сеттер прототипа и диспатчит input/change.
 * Нативный сеттер обязателен: React/Vue перехватывают присвоение input.value
 * напрямую, и без него значение «не прилипает» к состоянию компонента.
 */
export function fillInput(input, value) {
  const proto = typeof HTMLInputElement !== "undefined" ? HTMLInputElement.prototype : null;
  const setter = proto && Object.getOwnPropertyDescriptor(proto, "value")?.set;
  input.focus?.();
  if (setter) setter.call(input, value);
  else input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
  input.blur?.();
}

/** Короткая подсветка заполненного поля (проверено в v1, не мешает валидаторам). */
function highlight(input) {
  try {
    const prevOutline = input.style.outline;
    const prevOffset = input.style.outlineOffset;
    input.style.outline = "2px solid #38bdf8";
    input.style.outlineOffset = "1px";
    setTimeout(() => {
      input.style.outline = prevOutline;
      input.style.outlineOffset = prevOffset;
    }, 1600);
  } catch {
    /* style может быть недоступен */
  }
}

/**
 * Заполняет распознанные поля согласно fillMode:
 *   "email"           — только email;
 *   "email+password"  — email + пароль + confirm тем же паролем;
 *   "full"            — плюс username.
 * Confirm всегда получает тот же пароль, что и основное поле (фаза 3).
 * @returns {{email: number, password: number, username: number, total: number}}
 */
export function fillFields(fields, identity, { fillMode = "email+password" } = {}) {
  const f = fields ?? detectFields();
  let email = 0;
  let password = 0;
  let username = 0;

  for (const input of f.email) {
    fillInput(input, identity.email);
    highlight(input);
    email++;
  }
  if (fillMode !== "email") {
    // Пароль и его подтверждение — одним значением
    for (const input of [...f.password, ...f.confirm]) {
      fillInput(input, identity.password);
      highlight(input);
      password++;
    }
  }
  if (fillMode === "full" && identity.username) {
    for (const input of f.username) {
      fillInput(input, identity.username);
      highlight(input);
      username++;
    }
  }
  return { email, password, username, total: email + password + username };
}

/**
 * Заполняет ТОЛЬКО ПУСТЫЕ поля (v3 — многошаговые формы): когда следующий
 * шаг формы открывает новые поля пароля, они получают те же данные.
 * Никогда не перезаписывает введённое пользователем.
 * @returns {{email: number, password: number, username: number, total: number, requirements: object|null}}
 *   requirements — требования новых password-полей (если генератору нужно
 *   перегенерировать пароль под более строгие требования шага 2).
 */
export function fillEmptyFields(fields, identity, { fillMode = "email+password" } = {}) {
  const f = fields ?? detectFields();
  let email = 0;
  let password = 0;
  let username = 0;
  const filledInputs = new Set();

  for (const input of f.email) {
    if ((input.value ?? "") !== "") continue;
    fillInput(input, identity.email);
    highlight(input);
    filledInputs.add(input);
    email++;
  }
  if (fillMode !== "email") {
    for (const input of [...f.password, ...f.confirm]) {
      if ((input.value ?? "") !== "") continue;
      fillInput(input, identity.password);
      highlight(input);
      filledInputs.add(input);
      password++;
    }
  }
  if (fillMode === "full" && identity.username) {
    for (const input of f.username) {
      if ((input.value ?? "") !== "") continue;
      fillInput(input, identity.username);
      highlight(input);
      filledInputs.add(input);
      username++;
    }
  }
  // Требования новых полей пароля (не заполненных ранее): пароль мог быть
  // сгенерирован до появления этих полей и не удовлетворять их правилам
  let requirements = null;
  if (password > 0) {
    requirements = fieldRequirements(f);
  }
  return { email, password, username, total: email + password + username, requirements, filledInputs };
}
