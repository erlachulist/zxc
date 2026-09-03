/**
 * AutoReg Assistant — инлайн-кнопка у email-полей (фаза 4, главный UX).
 *
 * Кнопка ~24×24 плавает справа-внутри каждого email-поля. Хост — Shadow DOM
 * (никакого инжекта стилей в страницу). Позиция от getBoundingClientRect(),
 * пересчёт при scroll/resize через requestAnimationFrame + passive listeners,
 * скрытие когда поле вне viewport. Появление с задержкой 500мс (не мигает
 * при загрузке). Занятый правый край (padding-right или своя иконка сайта)
 * → кнопка сдвигается левее. Клик = полный цикл заполнения через background
 * (RUN_FILL), состояния idle → loading → success/error, сброс в idle через 3с.
 */

import { detectFields } from "../core/form-filler.js";

const BTN_SIZE = 24;

const ICONS = {
  idle: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h16v16H4z" rx="2"/><path d="M4 7l8 6 8-6"/></svg>`,
  success: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12l5 5 11-11"/></svg>`,
  error: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="M5 5l14 14M19 5L5 19"/></svg>`,
};

const HOST_STYLES = `
  :host {
    position: fixed;
    width: ${BTN_SIZE + 2}px;
    height: ${BTN_SIZE + 2}px;
    z-index: 2147483647;
    pointer-events: none;
  }
  button {
    pointer-events: auto;
    width: ${BTN_SIZE}px;
    height: ${BTN_SIZE}px;
    border: 0;
    border-radius: 7px;
    background: #10151d;
    color: #e8edf5;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    box-shadow: 0 2px 8px rgba(0,0,0,.35);
    opacity: 0;
    transform: scale(.85);
    transition: opacity .18s ease, transform .18s ease, background .18s ease;
  }
  button.visible { opacity: 1; transform: scale(1); }
  button:hover { background: #2a3342; }
  button.loading svg { display: none; }
  button.loading::after {
    content: "";
    width: 12px;
    height: 12px;
    border: 2px solid rgba(255,255,255,.25);
    border-top-color: #fff;
    border-radius: 50%;
    animation: ar-spin .7s linear infinite;
  }
  @keyframes ar-spin { to { transform: rotate(360deg); } }
  button.success { background: #16a34a; }
  button.error { background: #dc2626; }
`;

/** Контроллер одной кнопки: хост, позиционирование, состояния. */
class InlineButton {
  constructor(field) {
    this.field = field;
    this.host = document.createElement("div");
    this.root = this.host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = HOST_STYLES;
    this.btn = document.createElement("button");
    this.btn.type = "button";
    this.btn.setAttribute("aria-label", "AutoReg: заполнить форму");
    this.btn.innerHTML = ICONS.idle;
    this.root.append(style, this.btn);
    document.documentElement.appendChild(this.host);

    // Не триггерим обработчики сайта и не забираем фокус у поля
    this.btn.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
    }, true);
    this.btn.addEventListener("pointerdown", (e) => e.stopPropagation(), true);
    this.btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.onClick();
    });

    this.stateTimer = null;
    this.removed = false;
    this.setPosition();
  }

  setState(state, title = "") {
    if (this.removed) return;
    this.btn.className = state === "idle" ? "visible" : `${state} visible`;
    this.btn.innerHTML = state === "success" ? ICONS.success : state === "error" ? ICONS.error : ICONS.idle;
    // tooltip с причиной ошибки (title на хосте — работает с закрытым shadow)
    this.host.title = title;
    if (this.stateTimer) clearTimeout(this.stateTimer);
    if (state === "success" || state === "error") {
      this.stateTimer = setTimeout(() => this.setState("idle"), 3000);
    }
  }

  async onClick() {
    if (this.busy) return;
    this.busy = true;
    this.setState("loading");
    let resp = null;
    try {
      resp = await chrome.runtime.sendMessage({ type: "RUN_FILL" });
    } catch {
      // контекст расширения инвалидирован (перезагрузка расширения)
    }
    this.busy = false;
    if (resp?.ok) {
      this.setState("success", resp.email ? `Email: ${resp.email}` : "Готово");
    } else {
      this.setState("error", resp?.error || "Не удалось заполнить — подробности в расширении");
    }
  }

  /**
   * Позиционирование: справа-внутри поля; учёт занятого правого края
   * (большой padding-right или абсолютная иконка сайта внутри обёртки поля).
   */
  setPosition() {
    if (this.removed) return;
    const rect = this.field.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) {
      this.host.style.display = "none";
      return;
    }
    // Вне viewport — скрываем (фаза 4: скрытие когда поле вне видимости)
    if (rect.bottom < 0 || rect.top > innerHeight || rect.right < 0 || rect.left > innerWidth) {
      this.host.style.display = "none";
      return;
    }
    this.host.style.display = "";

    // Отступ от правого края: 6px по умолчанию; больше, если край занят
    let rightInset = 6;
    const padRight = parseFloat(getComputedStyle(this.field).paddingRight) || 0;
    if (padRight >= 34) rightInset = padRight + 4; // сайт резервирует место под иконку
    rightInset = Math.max(rightInset, this.siteIconInset(rect)); // своя иконка сайта

    const maxInset = Math.max(rect.width / 2, 20); // не залезать на текст глубже половины поля
    rightInset = Math.min(rightInset, maxInset);
    const size = BTN_SIZE + 2;
    const left = Math.max(rect.right - rightInset - size, rect.left + 2);
    const top = rect.top + Math.max(0, (rect.height - size) / 2);
    this.host.style.left = `${Math.round(left)}px`;
    this.host.style.top = `${Math.round(top)}px`;
  }

  /** Ищет иконку сайта в правой зоне поля (абсолютные элементы обёртки). */
  siteIconInset(fieldRect) {
    try {
      const wrapper = this.field.parentElement;
      if (!wrapper) return 0;
      const strip = { left: fieldRect.right - 44, right: fieldRect.right + 2, top: fieldRect.top - 6, bottom: fieldRect.bottom + 6 };
      for (const el of wrapper.querySelectorAll("*")) {
        if (el === this.host || this.host.contains(el)) continue;
        const cs = getComputedStyle(el);
        if (!["absolute", "fixed"].includes(cs.position)) continue;
        if (cs.visibility === "hidden" || cs.display === "none") continue;
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        const overlaps = r.left < strip.right && r.right > strip.left && r.top < strip.bottom && r.bottom > strip.top;
        if (overlaps) return Math.round(fieldRect.right - r.left + 6);
      }
    } catch {
      /* позиционирование безопасно по умолчанию */
    }
    return 0;
  }

  remove() {
    this.removed = true;
    if (this.stateTimer) clearTimeout(this.stateTimer);
    this.host.remove();
  }
}

// ---------------------------------------------------------------------------
// Управление набором кнопок
// ---------------------------------------------------------------------------

const controllers = new Map(); // input → InlineButton
const pending = new Map(); // input → timeout (задержка появления 500мс)

function addController(field) {
  // Появление с задержкой 500мс — кнопки не мигают при загрузке/перерисовке
  if (pending.has(field)) return;
  pending.set(
    field,
    setTimeout(() => {
      pending.delete(field);
      if (!field.isConnected || controllers.has(field)) return;
      const rect = field.getBoundingClientRect?.();
      if (!rect || rect.width === 0) return; // невидимое поле — кнопка не нужна
      controllers.set(field, new InlineButton(field));
      positionAll();
    }, 500)
  );
}

function removeController(field) {
  const timer = pending.get(field);
  if (timer) {
    clearTimeout(timer);
    pending.delete(field);
  }
  const controller = controllers.get(field);
  if (controller) {
    controller.remove();
    controllers.delete(field);
  }
}

function scan() {
  const fields = detectFields();
  // Одна кнопка на форму: у «Confirm email» и прочих дублей внутри той же
  // формы кнопки не нужны — клик заполняет все email-поля сразу
  const seenForms = new Set();
  const live = new Set();
  for (const field of fields.email) {
    const form = field.closest?.("form") ?? null;
    if (form) {
      if (seenForms.has(form)) continue;
      seenForms.add(form);
    }
    live.add(field);
  }
  // Новые email-поля (SPA-роутинг, модалки) → кнопки
  for (const field of live) addController(field);
  // Исчезнувшие поля → убрать кнопки
  for (const field of controllers.keys()) {
    if (!live.has(field) || !field.isConnected) removeController(field);
  }
  for (const field of pending.keys()) {
    if (!live.has(field) || !field.isConnected) removeController(field);
  }
}

let rafPending = false;
function positionAll() {
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => {
    rafPending = false;
    for (const controller of controllers.values()) controller.setPosition();
  });
}

// Пересчёт при скролле/resize: passive + rAF (фаза 4)
window.addEventListener("scroll", positionAll, { passive: true, capture: true });
window.addEventListener("resize", positionAll, { passive: true });

// SPA дорисовывают поля динамически — следим за DOM (debounce)
let scanTimer = null;
const observer = new MutationObserver(() => {
  if (scanTimer) clearTimeout(scanTimer);
  scanTimer = setTimeout(scan, 400);
});
observer.observe(document.documentElement, { childList: true, subtree: true });

scan();
