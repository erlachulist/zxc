/* popup/popup.js — v3: панель v2 + текущий email/письма как в v1 + кнопка
 * «Заполнить» у каждой записи журнала. Вся сетевая логика в background. */

(function () {
  "use strict";

  const STATUS = {
    generated: "создан",
    form_filled: "форма заполнена",
    submitted: "отправлено",
    pending_verification: "ждём письма",
    verified: "подтверждено",
    failed: "ошибка",
  };

  const CURRENT_KEY = "ar_popup_current";
  const PROVIDER_KEY = "ar_popup_provider";

  const state = {
    records: [],
    settings: {},
    providers: { builtin: [], custom: [] },
    crypto: { enabled: false, unlocked: false },
    query: "",
    currentId: null,
    pollTimer: null,
  };

  // --- helpers -------------------------------------------------------------
  const $ = (s, r = document) => r.querySelector(s);

  function el(tag, props, ...kids) {
    const n = document.createElement(tag);
    if (props)
      for (const k in props) {
        const v = props[k];
        if (v == null) continue;
        if (k === "class") n.className = v;
        else if (k === "html") n.innerHTML = v;
        else if (k === "text") n.textContent = v;
        else if (k === "dataset") Object.assign(n.dataset, v);
        else if (k.startsWith("on") && typeof v === "function") n.addEventListener(k.slice(2).toLowerCase(), v);
        else n.setAttribute(k, v);
      }
    for (const kid of kids.flat()) {
      if (kid == null || kid === false) continue;
      n.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return n;
  }

  const ICON = {
    copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
    eye: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>',
    eyeoff: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.9 4.2A9.1 9.1 0 0 1 12 4c6.5 0 10 7 10 7a13.2 13.2 0 0 1-2.2 3M6.6 6.6A13.2 13.2 0 0 0 2 11s3.5 7 10 7a9 9 0 0 0 4.2-1M3 3l18 18"/></svg>',
    trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m2 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/></svg>',
    back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>',
    mail: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-10 5L2 7"/></svg>',
    link: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1"/><path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1"/></svg>',
    key: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="7.5" cy="15.5" r="4.5"/><path d="m10.5 12.5 8-8m-3 3 3 3m-6 0 3 3"/></svg>',
    bolt: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2 4 14h7l-1 8 9-12h-7z"/></svg>',
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
  };
  const iconEl = (name) => el("span", { class: "i", html: ICON[name], style: "display:inline-flex;width:15px;height:15px" });

  function rpc(type, payload) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(Object.assign({ type }, payload || {}), (resp) => {
        const e = chrome.runtime.lastError;
        if (e) return reject(new Error(e.message));
        if (!resp) return reject(new Error("Нет ответа от расширения"));
        if (resp.ok === false) return reject(new Error(typeof resp.error === "string" ? resp.error : (resp.error && resp.error.message) || "Ошибка"));
        resolve(resp);
      });
    });
  }

  let toastTimer = null;
  function toast(text, ok = true) {
    const t = $("#toast");
    t.textContent = text;
    t.className = "toast show " + (ok ? "ok" : "err");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.className = "toast"), 2600);
  }

  async function copy(text) {
    try {
      await navigator.clipboard.writeText(String(text));
      toast("Скопировано");
    } catch {
      toast("Не удалось скопировать", false);
    }
  }

  function timeAgo(ts) {
    const s = Math.floor((Date.now() - ts) / 1000);
    if (s < 45) return "только что";
    if (s < 3600) return Math.floor(s / 60) + " мин назад";
    if (s < 86400) return Math.floor(s / 3600) + " ч назад";
    if (s < 604800) return Math.floor(s / 86400) + " дн назад";
    return new Date(ts).toLocaleDateString("ru-RU");
  }
  const fmtDate = (ts) =>
    new Date(ts).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

  function download(filename, text) {
    const blob = new Blob([text], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = el("a", { href: url, download: filename });
    document.body.append(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(url);
      a.remove();
    }, 800);
  }

  function pill(status) {
    return el("span", { class: "pill", dataset: { status } }, el("span", { class: "dot" }), STATUS[status] || status);
  }

  async function activeTab() {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      return tab || null;
    } catch {
      return null;
    }
  }

  function isEncrypted(r) {
    return typeof r.password === "string" && r.password.startsWith("v1.");
  }

  // --- data ----------------------------------------------------------------
  async function reload() {
    const s = await rpc("GET_STATE");
    state.records = s.records || [];
    state.settings = s.settings || {};
    state.providers = s.providers || { builtin: [], custom: [] };
    state.crypto = s.crypto || { enabled: false, unlocked: false };
    $("#brand-sub").textContent = state.crypto.enabled
      ? state.crypto.unlocked ? "Ассистент регистраций · 🔓" : "Ассистент регистраций · 🔒"
      : "Ассистент регистраций";
  }

  async function loadContext() {
    const box = $("#ctx");
    box.innerHTML = "";
    try {
      const tab = await activeTab();
      if (!tab) return;
      let host = "";
      try {
        host = new URL(tab.url).hostname;
      } catch {}
      let form = null;
      try {
        form = await chrome.tabs.sendMessage(tab.id, { type: "GET_FORM_STATUS" });
      } catch {}
      if (form && form.found) {
        box.append(
          el("span", { class: "ok" }, "●"),
          el("span", {}, form.formKind === "login" ? "Форма входа на " : "Форма найдена на "),
          el("span", { class: "host" }, host)
        );
        if (form.formKind === "login") box.append(el("span", { class: "login-tag" }, "· «Заполнить» подставит данные из журнала"));
      } else if (host) {
        box.append(el("span", { class: "no" }, "○"), el("span", { class: "host" }, host));
      }
    } catch {}
  }

  function renderProviders() {
    const sel = $("#provider-select");
    sel.innerHTML = "";
    sel.append(el("option", { value: "auto", text: "Авто (стратегия " + (state.settings.providerStrategy || "rotation") + ")" }));
    for (const p of state.providers.builtin || []) sel.append(el("option", { value: p.id, text: p.name + (p.enabled ? "" : " (выкл)") }));
    for (const c of state.providers.custom || []) sel.append(el("option", { value: c.id, text: c.name + (c.enabled ? "" : " (выкл)") }));
    chrome.storage.local.get(PROVIDER_KEY).then((d) => {
      const v = d && d[PROVIDER_KEY];
      if (v != null) sel.value = v;
      if (sel.value !== String(v) && v != null) sel.value = "auto";
    }).catch(() => {});
  }

  function currentProvider() {
    const v = $("#provider-select").value;
    return v === "auto" ? null : v;
  }

  // --- текущий email (удобство v1: почта и письма сразу) --------------------
  async function loadCurrent() {
    try {
      const d = await chrome.storage.local.get(CURRENT_KEY);
      state.currentId = (d && d[CURRENT_KEY]) || null;
    } catch {
      state.currentId = null;
    }
    if (state.currentId && !state.records.some((r) => r.id === state.currentId)) {
      state.currentId = null;
      chrome.storage.local.remove(CURRENT_KEY).catch(() => {});
    }
    renderCurrent();
    scheduleCurrentPoll();
  }

  function setCurrent(recordId) {
    state.currentId = recordId;
    chrome.storage.local.set({ [CURRENT_KEY]: recordId }).catch(() => {});
    renderCurrent();
    scheduleCurrentPoll();
  }

  function clearCurrent() {
    state.currentId = null;
    chrome.storage.local.remove(CURRENT_KEY).catch(() => {});
    renderCurrent();
    if (state.pollTimer) {
      clearInterval(state.pollTimer);
      state.pollTimer = null;
    }
  }

  function passwordLine(record, { container }) {
    const encrypted = isEncrypted(record);
    const val = el("div", { class: "val masked" }, record.password && !encrypted ? "••••••••••" : encrypted ? "🔒 зашифрован" : "—");
    const btns = [];

    if (record.password) {
      const eye = el("button", { class: "icon-btn", title: "Показать" });
      eye.innerHTML = ICON.eye;
      let shown = false;
      eye.addEventListener("click", async () => {
        try {
          if (shown) {
            val.textContent = encrypted ? "🔒 зашифрован" : "••••••••••";
            val.classList.add("masked");
            eye.innerHTML = ICON.eye;
            shown = false;
            return;
          }
          const r = await rpc("DECRYPT_PASSWORD", { recordId: record.id });
          if (r.locked) {
            toast("Разблокируйте пароли мастер-паролем", false);
            promptUnlock(container);
            return;
          }
          val.textContent = r.password || "—";
          val.classList.remove("masked");
          eye.innerHTML = ICON.eyeoff;
          shown = true;
        } catch (e) {
          toast(e.message, false);
        }
      });
      btns.push(eye);

      const cp = el("button", { class: "icon-btn", title: "Копировать" });
      cp.innerHTML = ICON.copy;
      cp.addEventListener("click", async () => {
        try {
          const r = await rpc("DECRYPT_PASSWORD", { recordId: record.id });
          if (r.locked) {
            toast("Разблокируйте пароли мастер-паролем", false);
            promptUnlock(container);
            return;
          }
          copy(r.password);
        } catch (e) {
          toast(e.message, false);
        }
      });
      btns.push(cp);
    }
    return el("div", { class: "copyline" }, val, ...btns);
  }

  function promptUnlock(container) {
    if (!container || container.querySelector(".unlock-box")) return;
    const inp = el("input", { class: "input", type: "password", placeholder: "Мастер-пароль" });
    const box = el(
      "div",
      { class: "unlock-box field fade-in" },
      el("span", { class: "eyebrow" }, "Разблокировать пароли"),
      el(
        "div",
        { class: "unlock" },
        inp,
        el(
          "button",
          {
            class: "btn btn-primary btn-sm",
            onclick: async () => {
              try {
                await rpc("CRYPTO_UNLOCK", { password: inp.value });
                toast("Разблокировано");
                box.remove();
                renderAll();
              } catch (e) {
                toast(e.message, false);
              }
            },
          },
          "OK"
        )
      )
    );
    container.prepend(box);
    inp.focus();
  }

  function renderCurrent() {
    const box = $("#current-box");
    box.innerHTML = "";
    const record = state.records.find((r) => r.id === state.currentId);
    if (!record) {
      box.hidden = true;
      return;
    }
    box.hidden = false;

    box.append(
      el(
        "div",
        { class: "current-hd" },
        el("span", { class: "eyebrow" }, "Текущий email"),
        el("span", { class: "ago" }, timeAgo(record.updatedAt || record.createdAt)),
        pill(record.status)
      )
    );
    box.append(el("div", { class: "copyline" }, el("div", { class: "val", text: record.email })));
    if (record.password) {
      box.append(passwordLine(record, { container: box }));
    }

    const checkBtn = el(
      "button",
      { class: "btn btn-sm", style: "width:100%" },
      iconEl("mail"),
      "Проверить почту"
    );
    checkBtn.addEventListener("click", async () => {
      checkBtn.disabled = true;
      checkBtn.textContent = "Проверяю…";
      try {
        const res = await rpc("CHECK_INBOX", { recordId: record.id });
        renderMails(box, res);
        await reload();
        renderCurrent();
        renderList();
      } catch (e) {
        toast(e.message, false);
      }
      checkBtn.disabled = false;
      checkBtn.innerHTML = "";
      checkBtn.append(iconEl("mail"), document.createTextNode("Проверить почту"));
    });
    box.append(checkBtn);
    box.append(
      el(
        "div",
        { style: "display:flex;gap:8px" },
        el(
          "button",
          {
            class: "btn btn-ghost btn-sm",
            style: "flex:1 1 auto",
            onclick: () => clearCurrent(),
          },
          "Убрать из панели"
        ),
        el(
          "button",
          {
            class: "btn btn-ghost btn-sm",
            style: "flex:1 1 auto",
            onclick: () => openDetail(record.id),
          },
          "Подробнее →"
        )
      )
    );

    const mailsHost = el("div", { class: "mails-host" });
    box.append(mailsHost);
    box.append(
      el(
        "div",
        { class: "mailbox-note" },
        "Ящик живёт ограниченное время. Если сайт отклоняет адрес — некоторые сайты блокируют домены временной почты, расширение само попробует другого провайдера."
      )
    );
  }

  function renderMails(container, res) {
    const host = container.querySelector(".mails-host");
    if (!host) return;
    host.innerHTML = "";
    const messages = res.messages || [];
    if (!messages.length) {
      host.append(el("div", { class: "empty", style: "padding:10px;font-size:12px" }, "Писем пока нет."));
      return;
    }
    if (res.code) {
      host.append(
        el(
          "div",
          { class: "verify", style: "margin-bottom:8px" },
          el("div", { class: "vtitle" }, iconEl("key"), "Код подтверждения"),
          el(
            "div",
            { style: "display:flex;align-items:center;justify-content:space-between;gap:10px" },
            el("span", { class: "code-big" }, res.code),
            el("button", { class: "btn btn-sm", onclick: () => copy(res.code) }, iconEl("copy"), "Копировать")
          )
        )
      );
    }
    const links = res.links || [];
    if (links.length) {
      const linkBox = el("div", { class: "verify", style: "margin-bottom:8px" });
      linkBox.append(el("div", { class: "vtitle" }, iconEl("link"), "Ссылка подтверждения"));
      linkBox.append(
        el(
          "button",
          {
            class: "btn btn-sm",
            style: "width:100%",
            onclick: async () => {
              try {
                await rpc("OPEN_LINK", { url: links[0], recordId: state.currentId });
                toast("Ссылка открыта");
                await reload();
                renderCurrent();
                renderList();
              } catch (e) {
                toast(e.message, false);
              }
            },
          },
          iconEl("link"),
          "Открыть ссылку"
        )
      );
      host.append(linkBox);
    }
    for (const m of messages.slice(0, 6)) {
      host.append(el("div", { class: "mail" }, el("div", { class: "msub" }, m.subject || "(без темы)"), el("div", { class: "mfrom" }, m.from || "")));
    }
  }

  function scheduleCurrentPoll() {
    if (state.pollTimer) {
      clearInterval(state.pollTimer);
      state.pollTimer = null;
    }
    const record = state.records.find((r) => r.id === state.currentId);
    if (!record) return;
    if (record.status !== "submitted" && record.status !== "pending_verification") return;
    state.pollTimer = setInterval(async () => {
      try {
        const res = await rpc("CHECK_INBOX", { recordId: state.currentId });
        const box = $("#current-box");
        renderMails(box, res);
        const r0 = state.records.find((r) => r.id === state.currentId);
        if (r0 && r0.status !== "submitted" && r0.status !== "pending_verification") {
          clearInterval(state.pollTimer);
          state.pollTimer = null;
        }
      } catch {
        /* тишина — молча прекращаем */
        if (state.pollTimer) clearInterval(state.pollTimer);
        state.pollTimer = null;
      }
    }, 5000);
  }

  // --- список --------------------------------------------------------------
  function filtered() {
    const q = state.query.trim().toLowerCase();
    if (!q) return state.records;
    return state.records.filter((r) =>
      [r.siteName, r.domain, r.email, r.username, (r.tags || []).join(" "), r.notes].join(" ").toLowerCase().includes(q)
    );
  }

  function dotStyle(status) {
    const c = {
      generated: "var(--slate)",
      form_filled: "var(--accent-2)",
      submitted: "var(--amber)",
      pending_verification: "var(--amber)",
      verified: "var(--green)",
      failed: "var(--red)",
    };
    return "background:" + (c[status] || "var(--slate)");
  }

  function renderList() {
    const list = $("#list");
    list.innerHTML = "";
    const items = filtered();
    $("#count").textContent = state.records.length;
    if (!items.length) {
      list.append(
        el(
          "div",
          { class: "empty" },
          state.records.length
            ? "Ничего не найдено."
            : "Пока нет записей. Нажмите «Заполнить форму» на странице регистрации или создайте email."
        )
      );
      return;
    }
    for (const r of items) {
      const fillBtn = el("button", {
        class: "rfill",
        title: "Заполнить форму на этой вкладке данными этой записи",
        html: ICON.bolt,
        onclick: async (e) => {
          e.stopPropagation();
          fillBtn.disabled = true;
          try {
            const res = await rpc("FILL_RECORD", { recordId: r.id });
            await reload();
            renderList();
            renderCurrent();
            toast(res.mode === "login" ? "Вход заполнен: " + res.email : "Заполнено из журнала: " + res.email);
          } catch (err) {
            toast(err.message, false);
          }
          fillBtn.disabled = false;
        },
      });
      const row = el(
        "div",
        { class: "row", onclick: () => openDetail(r.id) },
        el("span", { class: "rdot", style: dotStyle(r.status) }),
        el("div", { class: "rmid" }, el("div", { class: "rsite" }, r.siteName || r.domain || "—"), el("div", { class: "rmail" }, r.email || "—")),
        el("div", { class: "rright" }, pill(r.status), el("span", { class: "rtime" }, timeAgo(r.updatedAt || r.createdAt))),
        fillBtn
      );
      list.append(row);
    }
  }

  // --- детали --------------------------------------------------------------
  function openDetail(id) {
    const r = state.records.find((x) => x.id === id);
    if (!r) return;
    renderDetail(r);
    $("#view-list").classList.add("hidden");
    const d = $("#view-detail");
    d.classList.remove("hidden");
    d.classList.add("fade-in");
  }

  function goList() {
    $("#view-detail").classList.add("hidden");
    $("#view-list").classList.remove("hidden");
    renderList();
  }

  function renderDetail(r) {
    const root = $("#view-detail");
    root.innerHTML = "";

    const head = el(
      "div",
      { class: "dt-hd" },
      el("button", { class: "icon-btn", title: "Назад", onclick: goList, html: ICON.back }),
      el(
        "div",
        { class: "dt-title" },
        el("div", { class: "dt-site" }, r.siteName || r.domain || "—"),
        el("div", { class: "dt-url" }, r.url || r.domain || "")
      ),
      pill(r.status)
    );

    const body = el("div", { class: "dt-body" });

    // заполнить форму этими данными (v3)
    body.append(
      el(
        "button",
        {
          class: "btn btn-primary",
          onclick: async (e) => {
            const btn = e.currentTarget;
            btn.disabled = true;
            try {
              const res = await rpc("FILL_RECORD", { recordId: r.id });
              toast(res.mode === "login" ? "Вход заполнен: " + res.email : "Заполнено: " + res.email);
              await reload();
            } catch (err) {
              toast(err.message, false);
            }
            btn.disabled = false;
          },
        },
        iconEl("bolt"),
        "Заполнить форму этими данными"
      )
    );

    // email
    body.append(el("div", { class: "field" }, el("span", { class: "eyebrow" }, "Email"), el("div", { class: "copyline" }, el("div", { class: "val", text: r.email }), copyBtn(r.email))));
    // password
    if (r.password || r.encrypted) {
      body.append(
        el(
          "div",
          { class: "field" },
          el("span", { class: "eyebrow" }, isEncrypted(r) ? "Пароль · зашифрован" : "Пароль"),
          passwordLine(r, { container: body })
        )
      );
    }
    // username
    if (r.username) {
      body.append(el("div", { class: "field" }, el("span", { class: "eyebrow" }, "Имя пользователя"), el("div", { class: "copyline" }, el("div", { class: "val", text: r.username }), copyBtn(r.username))));
    }

    // meta
    body.append(
      el(
        "div",
        { class: "kv" },
        el("span", { class: "k" }, "Провайдер"),
        el("span", { class: "v" }, r.providerName || "—"),
        el("span", { class: "k" }, "Создано"),
        el("span", { class: "v" }, fmtDate(r.createdAt)),
        el("span", { class: "k" }, "Обновлено"),
        el("span", { class: "v" }, fmtDate(r.updatedAt || r.createdAt))
      )
    );

    // verification
    const v = r.verification || {};
    if (v.otpCode || v.link) {
      const box = el("div", { class: "verify" });
      if (v.otpCode) {
        box.append(
          el("div", { class: "vtitle" }, iconEl("key"), "Код подтверждения"),
          el(
            "div",
            { style: "display:flex;align-items:center;justify-content:space-between;gap:10px" },
            el("span", { class: "code-big" }, v.otpCode),
            el("button", { class: "btn btn-sm", onclick: () => copy(v.otpCode) }, iconEl("copy"), "Копировать")
          )
        );
      }
      if (v.link) {
        box.append(
          el("div", { class: "vtitle", style: v.otpCode ? "margin-top:10px" : "" }, iconEl("link"), "Ссылка подтверждения"),
          el(
            "button",
            {
              class: "btn btn-sm",
              style: "width:100%",
              onclick: async () => {
                try {
                  await rpc("OPEN_LINK", { url: v.link, recordId: r.id });
                  toast("Ссылка открыта");
                } catch (e) {
                  toast(e.message, false);
                }
              },
            },
            iconEl("link"),
            "Открыть ссылку"
          )
        );
      }
      body.append(el("div", { class: "field" }, el("span", { class: "eyebrow" }, "Верификация"), box));
    }

    // check mail
    const mailBox = el("div", { class: "field" });
    const checkBtn = el(
      "button",
      { class: "btn btn-sm", style: "width:100%" },
      iconEl("mail"),
      "Проверить почту"
    );
    checkBtn.addEventListener("click", async () => {
      checkBtn.disabled = true;
      checkBtn.textContent = "Проверяю…";
      try {
        const res = await rpc("CHECK_INBOX", { recordId: r.id });
        renderDetailMails(mailsHost, res, r);
      } catch (e) {
        toast(e.message, false);
      }
      checkBtn.disabled = false;
      checkBtn.innerHTML = "";
      checkBtn.append(iconEl("mail"), document.createTextNode("Проверить почту"));
    });
    const mailsHost = el("div", { style: "margin-top:8px" });
    mailBox.append(el("span", { class: "eyebrow" }, "Входящие"), checkBtn, mailsHost);
    body.append(mailBox);

    // tags
    body.append(el("div", { class: "field" }, el("span", { class: "eyebrow" }, "Теги"), tagsField(r)));

    // notes
    const notes = el("textarea", { class: "textarea", placeholder: "Заметки…" });
    notes.value = r.notes || "";
    notes.addEventListener("change", async () => {
      try {
        await rpc("UPDATE_RECORD", { recordId: r.id, patch: { notes: notes.value } });
        toast("Сохранено");
      } catch (e) {
        toast(e.message, false);
      }
    });
    body.append(el("div", { class: "field" }, el("span", { class: "eyebrow" }, "Заметки"), notes));

    // timeline
    if ((r.attempts || []).length) {
      const tl = el("div", { class: "timeline" });
      for (const a of r.attempts) {
        tl.append(
          el(
            "div",
            { class: "tl" },
            el("span", { class: "tl-dot" }),
            el("div", {}, el("div", { class: "tl-txt" }, a.error), el("div", { class: "tl-time" }, fmtDate(a.timestamp)))
          )
        );
      }
      body.append(el("div", { class: "field" }, el("span", { class: "eyebrow" }, "История"), tl));
    }

    // delete
    body.append(
      el(
        "div",
        { class: "dt-actions" },
        el(
          "button",
          {
            class: "btn btn-danger",
            onclick: async () => {
              try {
                await rpc("DELETE_RECORD", { recordId: r.id });
                if (state.currentId === r.id) clearCurrent();
                await reload();
                goList();
                toast("Запись удалена");
              } catch (e) {
                toast(e.message, false);
              }
            },
          },
          iconEl("trash"),
          "Удалить запись"
        )
      )
    );

    root.append(head, body);
  }

  function copyBtn(value) {
    const cp = el("button", { class: "icon-btn", title: "Копировать", html: ICON.copy });
    cp.addEventListener("click", () => copy(value));
    return cp;
  }

  function renderDetailMails(host, res, r) {
    host.innerHTML = "";
    const messages = res.messages || [];
    if (!messages.length) {
      host.append(el("div", { class: "empty", style: "padding:14px" }, "Писем пока нет."));
      return;
    }
    if (res.code) {
      host.append(
        el(
          "div",
          { class: "verify" },
          el("div", { class: "vtitle" }, iconEl("key"), "Код подтверждения"),
          el(
            "div",
            { style: "display:flex;align-items:center;justify-content:space-between;gap:10px" },
            el("span", { class: "code-big" }, res.code),
            el("button", { class: "btn btn-sm", onclick: () => copy(res.code) }, iconEl("copy"), "Копировать")
          )
        )
      );
    }
    for (const m of messages.slice(0, 8)) {
      host.append(el("div", { class: "mail" }, el("div", { class: "msub" }, m.subject || "(без темы)"), el("div", { class: "mfrom" }, m.from || "")));
    }
    const links = res.links || [];
    if (links.length) {
      host.append(
        el(
          "button",
          {
            class: "btn btn-sm",
            style: "margin-top:6px;width:100%",
            onclick: () =>
              rpc("OPEN_LINK", { url: links[0], recordId: r.id })
                .then(() => toast("Ссылка открыта"))
                .catch((e) => toast(e.message, false)),
          },
          iconEl("link"),
          "Открыть ссылку подтверждения"
        )
      );
    }
  }

  function tagsField(r) {
    const wrap = el("div", { class: "tags-input" });
    function paint() {
      wrap.innerHTML = "";
      for (const t of r.tags || []) {
        wrap.append(
          el(
            "span",
            { class: "tag" },
            t,
            el("button", {
              title: "Удалить",
              text: "×",
              onclick: async () => {
                r.tags = (r.tags || []).filter((x) => x !== t);
                try {
                  await rpc("UPDATE_RECORD", { recordId: r.id, patch: { tags: r.tags } });
                } catch (e) {
                  toast(e.message, false);
                }
                paint();
              },
            })
          )
        );
      }
      const inp = el("input", {
        class: "input",
        style: "flex:1 1 90px;min-width:90px;padding:5px 8px;font-size:12px",
        placeholder: "+ тег",
        onkeydown: async (e) => {
          if (e.key !== "Enter") return;
          const val = inp.value.trim();
          if (!val) return;
          r.tags = [...new Set([...(r.tags || []), val])];
          try {
            await rpc("UPDATE_RECORD", { recordId: r.id, patch: { tags: r.tags } });
          } catch (err) {
            toast(err.message, false);
          }
          paint();
        },
      });
      wrap.append(inp);
    }
    paint();
    return wrap;
  }

  function renderAll() {
    renderProviders();
    renderList();
    renderCurrent();
  }

  // --- действия ------------------------------------------------------------

  async function doFill() {
    const btn = $("#btn-fill");
    btn.disabled = true;
    try {
      const tab = await activeTab();
      if (!tab || tab.id == null) throw new Error("Нет активной вкладки");
      const res = await rpc("FILL_FORM", { tabId: tab.id, providerName: currentProvider() });
      await reload();
      if (res.recordId) setCurrent(res.recordId);
      renderAll();
      if (res.mode === "login") {
        toast("Вход заполнен из журнала: " + res.email);
      } else {
        toast("Заполнено: " + res.email);
      }
    } catch (e) {
      toast(e.message, false);
    }
    btn.disabled = false;
  }

  async function doGenerate() {
    const btn = $("#btn-gen");
    btn.disabled = true;
    try {
      const tab = await activeTab();
      let siteDomain = "";
      if (tab && tab.url) {
        try {
          siteDomain = new URL(tab.url).hostname;
        } catch {}
      }
      const res = await rpc("GENERATE_EMAIL", { providerName: currentProvider(), siteDomain });
      await reload();
      if (res.recordId) setCurrent(res.recordId);
      renderAll();
      toast("Создан email: " + res.email);
    } catch (e) {
      toast(e.message, false);
    }
    btn.disabled = false;
  }

  // --- init ----------------------------------------------------------------
  function wire() {
    $("#btn-fill").addEventListener("click", doFill);
    $("#btn-gen").addEventListener("click", doGenerate);
    $("#btn-settings").addEventListener("click", () => chrome.runtime.openOptionsPage());
    $("#btn-options").addEventListener("click", () => chrome.runtime.openOptionsPage());
    $("#provider-select").addEventListener("change", (e) => {
      chrome.storage.local.set({ [PROVIDER_KEY]: e.target.value }).catch(() => {});
    });
    $("#btn-export").addEventListener("click", () => {
      if (!state.records.length) return toast("Нет данных для экспорта", false);
      download("autoreg-records-" + Date.now() + ".json", JSON.stringify(state.records, null, 2));
      toast("Экспортировано " + state.records.length + " записей");
    });
    const search = $("#search");
    search.addEventListener("input", () => {
      state.query = search.value;
      renderList();
    });
  }

  (async function init() {
    wire();
    try {
      await reload();
    } catch (e) {
      toast("Ошибка загрузки: " + e.message, false);
    }
    renderAll();
    loadCurrent();
    loadContext();
  })();
})();
