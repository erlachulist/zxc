/**
 * AutoReg Assistant — баннер-панель сверху страницы (v3).
 *
 * Хост — Shadow DOM (никаких стилей в страницу). Виды баннеров:
 *  - информационный/ошибка: текст, авто-скрытие;
 *  - с кнопкой-действием: {type, ...payload} в background по клику
 *    (например «Открыть ссылку подтверждения» — клик = user gesture);
 *  - showCode: OTP-код крупно + кнопка «Копировать» (когда поле на
 *    странице не найдено — фикс бага «код кидается, а подтвердить нельзя»);
 *  - showLoginOffer: «Войти как {email}» — предложение заполнить форму
 *    логина сохранёнными данными (клик по кнопке шлёт RUN_LOGIN_FILL).
 */

const BANNER_STYLES = `
  :host {
    all: initial;
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    z-index: 2147483647;
    display: flex;
    justify-content: center;
    pointer-events: none;
    font: 13px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  .banner {
    pointer-events: auto;
    margin: 10px 12px 0;
    max-width: 520px;
    width: calc(100% - 24px);
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 14px;
    border-radius: 12px;
    background: #0b1220;
    color: #e8edf5;
    box-shadow: 0 12px 36px rgba(0,0,0,.5);
    border: 1px solid #223049;
    border-left: 3px solid var(--accent, #38bdf8);
    opacity: 0;
    transform: translateY(-8px);
    transition: opacity .2s ease, transform .2s ease;
  }
  .banner.shown { opacity: 1; transform: translateY(0); }
  .banner.error { --accent: #f87171; }
  .banner .icon {
    flex: none;
    width: 30px; height: 30px;
    border-radius: 8px;
    background: #132038;
    display: flex; align-items: center; justify-content: center;
    color: #7dd3fc;
  }
  .banner .icon svg { width: 16px; height: 16px; }
  .banner .body { flex: 1; min-width: 0; word-break: break-word; }
  .banner .title { font-weight: 650; margin: 0; }
  .banner .sub { margin: 2px 0 0; color: #9fb0c9; font-size: 12px; }
  .banner .code {
    font: 700 18px/1.3 ui-monospace, Menlo, Consolas, monospace;
    letter-spacing: 3px;
    color: #fff;
    margin: 4px 0 0;
  }
  .banner .text { flex: 1; min-width: 0; word-break: break-word; }
  .banner button {
    flex: none;
    border: 0;
    border-radius: 9px;
    padding: 8px 12px;
    background: #2563eb;
    color: #fff;
    font: inherit;
    font-weight: 600;
    cursor: pointer;
    white-space: nowrap;
    transition: background .15s ease;
  }
  .banner button:hover { background: #1d4ed8; }
  .banner button.ghost {
    background: transparent;
    color: #9fb0c9;
    padding: 8px 9px;
  }
  .banner button.ghost:hover { color: #fff; background: #182741; }
`;

const KEY_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="7.5" cy="15.5" r="4.5"/><path d="m10.5 12.5 8-8"/><path d="m17 5 3 3"/><path d="m14 8 3 3"/></svg>';
const USER_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>';

let host = null;
let root = null;
let hideTimer = null;

function ensureHost() {
  if (host?.isConnected) return;
  host = document.createElement("div");
  root = host.attachShadow({ mode: "closed" });
  const style = document.createElement("style");
  style.textContent = BANNER_STYLES;
  root.append(style);
  document.documentElement.appendChild(host);
}

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function svgIcon(svg) {
  const span = el("span", "icon");
  span.innerHTML = svg;
  return span;
}

function mount(banner, ttl) {
  ensureHost();
  hide();
  root.append(banner);
  requestAnimationFrame(() => banner.classList.add("shown"));
  if (ttl > 0) hideTimer = setTimeout(hide, ttl);
}

function hide() {
  if (hideTimer) {
    clearTimeout(hideTimer);
    hideTimer = null;
  }
  if (!root) return;
  for (const banner of [...root.querySelectorAll(".banner")]) {
    banner.classList.remove("shown");
    setTimeout(() => banner.remove(), 250);
  }
}

/** Отправка в background без падения при инвалидированном контексте. */
function send(msg) {
  try {
    chrome.runtime.sendMessage(msg).catch(() => {});
  } catch {
    /* контекст расширения мог инвалидироваться */
  }
}

/**
 * Показывает простой баннер (текст / ошибка / кнопка-действие).
 * @param {object} msg
 *   text, isError, actionLabel, action {type,...payload}, autoHideMs
 * @returns {boolean}
 */
export function showBanner(msg) {
  if (!msg?.text) return false;
  const banner = el("div", "banner" + (msg.isError ? " error" : ""));
  const text = el("span", "text", String(msg.text));
  banner.append(text);
  if (msg.actionLabel && msg.action) {
    const button = el("button", null, String(msg.actionLabel));
    button.type = "button";
    button.addEventListener("click", () => {
      send(msg.action);
      hide();
    });
    banner.append(button);
  }
  const ttl = msg.autoHideMs ?? (msg.action ? 60000 : 4000);
  mount(banner, ttl);
  return true;
}

/**
 * Баннер с OTP-кодом и кнопкой «Копировать» (когда поле не найдено).
 * @param {string} code
 */
export function showCode(code) {
  const banner = el("div", "banner");
  banner.append(svgIcon(KEY_SVG));
  const body = el("div", "body");
  body.append(el("p", "title", "Код подтверждения из письма"));
  body.append(el("p", "code", String(code)));
  banner.append(body);
  const copyBtn = el("button", null, "Копировать");
  copyBtn.type = "button";
  copyBtn.addEventListener("click", async (e) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(String(code));
      copyBtn.textContent = "Скопировано";
    } catch {
      /* clipboard мог быть недоступен — код виден на баннере */
    }
  });
  banner.append(copyBtn);
  const closeBtn = el("button", "ghost", "✕");
  closeBtn.type = "button";
  closeBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    hide();
  });
  banner.append(closeBtn);
  mount(banner, 120000);
  return true;
}

/**
 * Баннер «Войти как {email}» — предложение заполнить форму логина
 * сохранёнными данными (фикс бага «после подтверждения предлагает новую
 * регистрацию вместо входа»).
 * @param {object} opts {email, recordId, siteName}
 */
export function showLoginOffer({ email, recordId, siteName }) {
  if (!email || !recordId) return false;
  const banner = el("div", "banner");
  banner.append(svgIcon(USER_SVG));
  const body = el("div", "body");
  body.append(el("p", "title", "Вход с сохранёнными данными"));
  body.append(el("p", "sub", `${email}${siteName ? ` · ${siteName}` : ""}`));
  banner.append(body);
  const fillBtn = el("button", null, "Заполнить логин");
  fillBtn.type = "button";
  fillBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    send({ type: "RUN_LOGIN_FILL", recordId });
    hide();
  });
  banner.append(fillBtn);
  const closeBtn = el("button", "ghost", "✕");
  closeBtn.type = "button";
  closeBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    hide();
  });
  banner.append(closeBtn);
  mount(banner, 120000);
  return true;
}

/** Скрыть текущий баннер (например, при повторном входе на страницу). */
export function hideBanner() {
  hide();
}
