/* Smoke-тест рендера: гоняем parser.js + app.js в общем контексте с заглушками
   DOM / fetch / localStorage, чтобы поймать runtime-ошибки без браузера. */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const DIR = __dirname;
const read = (f) => fs.readFileSync(path.join(DIR, f), "utf8");

// карта gid -> локальный снимок (fetch live будет "падать", уйдём в fallback)
const SNAP = {
  "data/book1_dota_group.csv": read("data/book1_dota_group.csv"),
  "data/book1_dota_playoff.csv": read("data/book1_dota_playoff.csv"),
  "data/book2_dota.csv": read("data/book2_dota.csv"),
  "data/lchb.json": read("data/lchb.json"),
};

// ---- фейковый DOM ----
const els = {};
function fakeEl() {
  return {
    _html: "", hidden: false, value: "", textContent: "", dataset: {},
    nextElementSibling: null,
    get innerHTML() { return this._html; },
    set innerHTML(v) { this._html = String(v); },
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    addEventListener() {}, querySelectorAll() { return []; },
    querySelector() { return null; }, closest() { return null; },
    setAttribute() {}, getAttribute() { return null; }, removeAttribute() {},
  };
}
const document = {
  querySelector(sel) { return (els[sel] = els[sel] || fakeEl()); },
  querySelectorAll() { return []; },
  addEventListener() {}, createElement() { return fakeEl(); },
  body: fakeEl(), visibilityState: "visible", activeElement: null,
};
const localStorageStore = { dotaPersonalMode: "1" }; // тестируем режим «Мои матчи»
const localStorage = {
  getItem(k) { return k in localStorageStore ? localStorageStore[k] : null; },
  setItem(k, v) { localStorageStore[k] = String(v); },
  removeItem(k) { delete localStorageStore[k]; },
};
async function fetch(url) {
  if (/^https?:/.test(url)) throw new Error("offline-test"); // имитируем отсутствие сети → fallback
  if (SNAP[url] != null) {
    const body = SNAP[url];
    return { ok: true, text: async () => body, json: async () => JSON.parse(body) };
  }
  return { ok: false, status: 404, text: async () => "", json: async () => ({}) };
}

const ctx = {
  console, Date, Math, JSON, Set, Map, Array, Object, String, Number, Promise,
  setInterval: () => 0, clearInterval: () => {},
  document, localStorage, fetch, module: undefined,
};
ctx.globalThis = ctx;
vm.createContext(ctx);

vm.runInContext(read("parser.js"), ctx, { filename: "parser.js" });
vm.runInContext(read("app.js"), ctx, { filename: "app.js" });

// init() асинхронный — ждём микротаски
setTimeout(() => {
  const content = els["#content"]._html;
  const hero = els["#hero"]._html;
  const status = els["#statusLine"]._html;
  const chips = els["#meChips"]._html;
  const checks = [
    ["hero отрисован", hero.includes("hero-card") || hero.includes("hero-skeleton")],
    ["есть карточки матчей", content.includes("class=\"card ")],
    ["есть группировка по дням", content.includes("class=\"day\"")],
    ["есть турнирные таблицы", content.includes("stable")],
    ["статус заполнен", status.includes("матчей")],
    ["чипы 'мои команды' (режим Мои матчи)", chips.includes("me-chip") && chips.includes("SZW") && chips.includes("CA_UNLIMITED") && chips.includes("TeamSpirt")],
    ["ЛЧБ загружен из JSON (TeamSpirt в матчах)", content.includes("TeamSpirt")],
    ["приоритет: есть тег замены или 'мой матч'", content.includes("tag skip") || content.includes("tag play")],
    ["сетка плей-офф отрисована", content.includes("class=\"bracket\"") && content.includes("class=\"bx ")],
    ["команды кликабельны (data-team)", content.includes("data-team=")],
    ["нет личных 'ты/твои' в текстах", !/\bты\b|\bтвои\b|\bтвой\b|\bтвоя\b/i.test(content + hero + chips)],
    ["нет 'undefined' в выводе", !content.includes("undefined") && !hero.includes("undefined") && !chips.includes("undefined")],
  ];
  // страница команды (модалка)
  try {
    ctx.openTeamModal("SZW");
    const modal = els["#modal .modal-card"]._html;
    checks.push(["модалка команды строится", modal.includes("винрейт") && modal.includes("SZW") && !modal.includes("undefined")]);
  } catch (e) { checks.push(["модалка команды строится", false]); console.error(e); }
  let ok = true;
  for (const [name, pass] of checks) { console.log(`${pass ? "✅" : "❌"} ${name}`); if (!pass) ok = false; }
  console.log("\nДлина content:", content.length, "| hero:", hero.length);
  console.log(ok ? "\nИТОГ: рендер прошёл без ошибок ✅" : "\nИТОГ: есть проблемы ❌");
  process.exit(ok ? 0 : 1);
}, 300);
