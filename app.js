/* ===================================================================
   app.js · Турниры по Dota 2
   Общее расписание (Google Таблицы + ЛЧБ из data/lchb.json) с режимом
   «Мои матчи». Чистый разбор данных — в parser.js.
   =================================================================== */

"use strict";

/* Команды владельца по турнирам (используются только в режиме «Мои матчи»). */
const MY_TEAMS = { komus: "SZW", sber: "CA_UNLIMITED", lchb: "TeamSpirt" };
/* Приоритет турниров: меньше = выше. Комус — замена, уступает Сберу/ЛЧБ. */
const PRIORITY = { sber: 1, lchb: 1, komus: 2 };
const TOUR_SHORT = { komus: "Комус", sber: "Сбер", lchb: "ЛЧБ" };

const TOURNAMENTS = [
  {
    id: "sber", name: "Сбер 2026",
    book: "1rU51zGE4kazEXCE0X9MONozmiwOSmrADI2lhTzCkJ98",
    dotabuff: "https://ru.dotabuff.com/esports/leagues/19695-sber-2026-corporate-esports",
    tabs: [{ key: "all", label: "Группы + плей-офф", gid: "0", fallback: "data/book2_dota.csv" }],
  },
  {
    id: "lchb", name: "ЛЧБ · Весна 2026", discipline: "Изумруд",
    dotabuff: "https://ru.dotabuff.com/esports/leagues/19455-bcl-spring-2026",
    json: "data/lchb.json",   // сайт ЛЧБ без CORS → данные кладёт scrape_lchb.py
  },
  {
    id: "komus", name: "Спартакиада Комус 2026", note: "замена",
    book: "1_0qzRmiyO_e-AHDmgD1uPm4OtuQbEmHx3_qhishINoE",
    dotabuff: "https://ru.dotabuff.com/esports/leagues/19755-komus-spartakiada-2026",
    tabs: [
      { key: "group", label: "Групповой этап", gid: "1522269301", fallback: "data/book1_dota_group.csv" },
      { key: "playoff", label: "Плей-офф", gid: "42106858", fallback: "data/book1_dota_playoff.csv" },
    ],
  },
];
const TOUR_BY_ID = Object.fromEntries(TOURNAMENTS.map((t) => [t.id, t]));

const LIVE_WINDOW_MIN = 150;       // окно "матч идёт сейчас"
const CONFLICT_WINDOW_MIN = 35;    // совпадение слота: матчи конфликтуют, если стартуют почти одновременно
const AUTO_REFRESH_MS = 120000;    // живое обновление данных раз в 2 минуты
const STORAGE = "dotaPersonalMode";
const MONTHS_NOM = ["", "января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];
const WEEKDAYS = ["воскресенье", "понедельник", "вторник", "среда", "четверг", "пятница", "суббота"];

const state = {
  matches: [], standings: [],
  source: "live", loadedAt: null,
  personal: localStorage.getItem(STORAGE) !== "0",   // по умолчанию показываем мои матчи
  filterTournament: "all", onlyUpcoming: false, search: "",
};

/* ================= ЗАГРУЗКА ================= */
async function fetchCsv(book, gid, fallback) {
  const live = `https://docs.google.com/spreadsheets/d/${book}/export?format=csv&gid=${gid}`;
  try {
    const r = await fetch(live, { cache: "no-store" });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const text = await r.text();
    if (text && text.length > 5) return { text, source: "live" };
    throw new Error("empty");
  } catch (e) {
    if (fallback) {
      try { const r2 = await fetch(fallback, { cache: "no-store" }); if (r2.ok) { const t = await r2.text(); if (t) return { text: t, source: "snapshot" }; } } catch (_) {}
    }
    throw e;
  }
}

async function loadJsonTournament(t, matches, standings) {
  const r = await fetch(t.json, { cache: "no-store" });
  if (!r.ok) throw new Error("HTTP " + r.status);
  const data = await r.json();
  for (const e of data.matches || []) {
    matches.push({
      tournamentId: t.id, tournament: t.name, discipline: t.discipline || "Dota 2",
      stage: e.stage || "Группа", dateStr: e.dateStr || "", timeStr: e.timeStr || "", ms: e.ms ?? null,
      team1: e.team1, team2: e.team2, score: parseScore(e.score || ""), stream: e.stream || "", url: e.url || "",
    });
  }
  for (const s of data.standings || [])
    standings.push({ tournamentId: t.id, tournament: t.name, group: s.group || data.league || "Таблица", place: s.place, team: s.team, w: s.w, l: s.l, maps: s.maps, pts: s.pts });
}

async function loadAll() {
  const matches = [], standings = [];
  let anyLive = false, anySnapshot = false, anyFail = false;
  const jobs = [];
  for (const t of TOURNAMENTS) {
    if (t.json) {
      jobs.push(loadJsonTournament(t, matches, standings).then(() => { anyLive = true; }).catch((e) => { anyFail = true; console.error("ЛЧБ:", e); }));
      continue;
    }
    for (const tab of t.tabs) {
      jobs.push(fetchCsv(t.book, tab.gid, tab.fallback)
        .then(({ text, source }) => {
          if (source === "live") anyLive = true; else anySnapshot = true;
          const res = parseSheet(parseCSV(text), { tournamentId: t.id, tournament: t.name, discipline: tab.label });
          // ЛЧБ-листы не имеют судьи/№ — на сайте они всё равно не показываются
          matches.push(...res.matches); standings.push(...res.standings);
        })
        .catch((e) => { anyFail = true; console.error("Не удалось загрузить", t.name, tab.label, e); }));
    }
  }
  await Promise.all(jobs);
  computeConflicts(matches);
  computeHypothetical(matches);
  state.matches = matches; state.standings = standings; state.loadedAt = new Date();
  state.source = anySnapshot ? "snapshot" : (anyLive || matches.length ? "live" : "fail");
  return matches.length > 0;
}

/* ================= КОМАНДЫ / ПРИОРИТЕТ ================= */
function isMyTeam(tid, team) { return MY_TEAMS[tid] && team === MY_TEAMS[tid]; }
function involvesMyTeam(m) { return isMyTeam(m.tournamentId, m.team1) || isMyTeam(m.tournamentId, m.team2); }

function computeConflicts(matches) {
  const mine = matches.filter((m) => m.ms != null && involvesMyTeam(m));
  for (const m of mine) { m.skip = false; m.conflictWith = null; m.clash = false; }
  const W = CONFLICT_WINDOW_MIN * 60000;
  for (const a of mine) for (const b of mine) {
    if (a === b || a.tournamentId === b.tournamentId) continue;
    if (!(a.ms < b.ms + W && b.ms < a.ms + W)) continue;   // стартуют почти одновременно
    const pa = PRIORITY[a.tournamentId] ?? 9, pb = PRIORITY[b.tournamentId] ?? 9;
    if (pa > pb) { a.skip = true; a.conflictWith = b; }
    else if (pa === pb) a.clash = true;
  }
}

/* Гипотетический путь по сетке: если моя команда проходит дальше — какие матчи её ждут.
   Слоты вида "WIN 7"/"LOSE 7" ссылаются на номер матча плей-офф. */
function isBracketStage(stage) { return /финал|место|пл[еэ]й/i.test(stage || ""); }
function slotRef(s) { const m = norm(s).match(/^(WIN|LOSE)\s*(\d+)$/i); return m ? { kind: m[1].toUpperCase(), n: +m[2] } : null; }
function refEq(s, kind, n) { const r = slotRef(s); return r && r.kind === kind && r.n === n; }

function computeHypothetical(matches) {
  for (const m of matches) { m.hypoMine = false; m.hypoSide = 0; m.hypoVia = ""; m.hypoTeam = ""; }
  for (const t of TOURNAMENTS) {
    const my = MY_TEAMS[t.id];
    if (!my) continue;
    const bracket = matches.filter((m) => m.tournamentId === t.id && isBracketStage(m.stage) && m.num);
    if (!bracket.length) continue;
    const seen = new Set();
    const queue = bracket.filter((m) => m.team1 === my || m.team2 === my).map((m) => +m.num);
    while (queue.length) {
      const n = queue.shift();
      for (const kind of ["WIN", "LOSE"]) {
        for (const m of bracket) {
          const side = refEq(m.team1, kind, n) ? 1 : (refEq(m.team2, kind, n) ? 2 : 0);
          if (!side || m.hypoMine || m.team1 === my || m.team2 === my) continue;
          m.hypoMine = true; m.hypoSide = side; m.hypoVia = kind; m.hypoTeam = my;
          if (kind === "WIN") queue.push(+m.num);   // цепочку продолжаем только по победам
        }
      }
    }
  }
}

/* ================= ВЫЧИСЛЕНИЯ ================= */
function matchStatus(m, now) {
  if (m.score.played) return "finished";
  if (m.ms == null) return "scheduled";
  if (now >= m.ms && now <= m.ms + LIVE_WINDOW_MIN * 60000) return "live";
  if (now > m.ms) return "finished";
  return "upcoming";
}
function realTeams(m) { return !isPlaceholder(m.team1) && !isPlaceholder(m.team2); }
function myUpcoming(now) {
  return state.matches.filter((m) => m.ms != null && involvesMyTeam(m) && !m.skip && !m.score.played && m.ms + LIVE_WINDOW_MIN * 60000 >= now && realTeams(m)).sort((a, b) => a.ms - b.ms);
}
function anyUpcoming(now) {
  return state.matches.filter((m) => m.ms != null && !m.score.played && m.ms + LIVE_WINDOW_MIN * 60000 >= now && realTeams(m)).sort((a, b) => a.ms - b.ms);
}
function skippedFor(m) { return state.matches.filter((x) => x.skip && x.conflictWith === m); }
function myTeamName(m) { return MY_TEAMS[m.tournamentId]; }
function opponentOf(m) { return m.team1 === myTeamName(m) ? m.team2 : m.team1; }

function fmtCountdown(ms) {
  if (ms <= 0) return "идёт";
  const tm = Math.floor(ms / 60000), d = Math.floor(tm / 1440), h = Math.floor((tm % 1440) / 60), mn = tm % 60, s = Math.floor((ms % 60000) / 1000);
  if (d > 0) return `${d} д ${h} ч ${mn} мин`;
  if (h > 0) return `${h} ч ${mn} мин`;
  if (tm > 0) return `${mn} мин ${String(s).padStart(2, "0")} с`;
  return `${s} с`;
}
function dayKey(m) { return m.ms != null ? new Date(m.ms).toISOString().slice(0, 10) : "tbd-" + m.dateStr; }
function fmtDay(m) {
  if (m.ms == null) return m.dateStr || "Дата уточняется";
  const d = new Date(m.ms + MSK_OFFSET * 3600000);
  return `${d.getUTCDate()} ${MONTHS_NOM[d.getUTCMonth() + 1]}, ${WEEKDAYS[d.getUTCDay()]}`;
}

/* ================= РЕНДЕР ================= */
const $ = (s) => document.querySelector(s);

function render() {
  const now = Date.now();
  renderModeUI();
  renderHero(now);
  renderAlert(now);
  renderFilters();
  renderContent(now);
  renderStatus();
}

function renderModeUI() {
  $("#myModeBtn").setAttribute("aria-pressed", state.personal ? "true" : "false");
  const chips = $("#meChips");
  if (!state.personal) { chips.hidden = true; return; }
  chips.hidden = false;
  chips.innerHTML = `<span class="lbl">Мои команды</span>` +
    TOURNAMENTS.filter((t) => MY_TEAMS[t.id]).map((t) => {
      const nm = MY_TEAMS[t.id];
      return `<span class="me-chip"><span class="mono" style="background:${teamColor(nm)}">${initials(nm)}</span><b>${esc(nm)}</b><i>${esc(TOUR_SHORT[t.id])}${t.note ? " · " + esc(t.note) : ""}</i></span>`;
    }).join("");
}

function renderHero(now) {
  const el = $("#hero");
  const m = state.personal ? (myUpcoming(now)[0] || anyUpcoming(now)[0]) : anyUpcoming(now)[0];
  if (!m) { el.innerHTML = `<div class="hero-skeleton">Нет предстоящих матчей 🏁<br><small style="color:var(--faint)">Все матчи сыграны или расписание ещё не опубликовано.</small></div>`; return; }
  const live = matchStatus(m, now) === "live";
  const mine = state.personal && involvesMyTeam(m);
  const m1 = state.personal && isMyTeam(m.tournamentId, m.team1), m2 = state.personal && isMyTeam(m.tournamentId, m.team2);
  const diff = m.ms - now;
  const tag = live ? (mine ? "Идёт матч" : "Идёт сейчас") : (mine ? "Мой следующий матч" : "Ближайший матч");
  const skips = state.personal ? skippedFor(m) : [];
  el.innerHTML = `
    <div class="hero-card ${live ? "is-live" : ""}">
      <div class="hero-tag">${live ? '<span class="dot-live"></span>' : ""}${esc(tag)}</div>
      <div class="hero-row">
        <div class="hero-team ${m1 ? "mine" : ""}"><div class="mono" style="background:${teamColor(m.team1)}">${initials(m.team1)}</div><div class="nm">${esc(prettyTeam(m.team1))}${m1 ? ' <span class="me-mark">Я</span>' : ""}</div></div>
        <div class="hero-mid"><span class="vs">VS</span><div class="hero-count ${live ? "live" : (diff < 3600000 ? "soon" : "")}" data-ms="${m.ms}">${live ? "идёт" : fmtCountdown(diff)}</div></div>
        <div class="hero-team ${m2 ? "mine" : ""}"><div class="mono" style="background:${teamColor(m.team2)}">${initials(m.team2)}</div><div class="nm">${esc(prettyTeam(m.team2))}${m2 ? ' <span class="me-mark">Я</span>' : ""}</div></div>
      </div>
      <div class="hero-meta">
        <span>🏆 <b>${esc(m.tournament)}</b></span>
        <span>${esc(m.discipline)} · ${esc(m.stage)}</span>
        <span>📅 <b>${esc(fmtDay(m))}</b> · <b>${esc(m.timeStr || "—")}</b> МСК</span>
        ${streamLink(m.stream)}${detailLink(m)}
      </div>
      ${skips.length ? `<div class="hero-note">В это же время — матч <b>${esc(prettyTeam(skips[0].team1))} vs ${esc(prettyTeam(skips[0].team2))}</b> (${esc(TOUR_SHORT[skips[0].tournamentId])}), он пропускается (замена).</div>` : ""}
    </div>`;
}

function renderAlert(now) {
  const el = $("#myAlert");
  if (!state.personal) { el.hidden = true; return; }
  const m = myUpcoming(now)[0];
  if (!m) { el.hidden = true; return; }
  const live = matchStatus(m, now) === "live";
  const opp = opponentOf(m);
  el.hidden = false;
  el.innerHTML = live
    ? `<span>🔴</span><span>Сейчас идёт матч <b>${esc(myTeamName(m))}</b> vs <b>${esc(prettyTeam(opp))}</b> <span class="accent">(${esc(TOUR_SHORT[m.tournamentId])})</span></span>`
    : `<span>🔔</span><span>Ближайший матч: <b>${esc(myTeamName(m))}</b> vs <b>${esc(prettyTeam(opp))}</b> — <span class="accent">через ${fmtCountdown(m.ms - now)}</span> · ${esc(m.timeStr)} МСК · ${esc(TOUR_SHORT[m.tournamentId])}</span>`;
}

function renderFilters() {
  const opts = [{ id: "all", name: "Все" }, ...TOURNAMENTS.map((t) => ({ id: t.id, name: TOUR_SHORT[t.id] || t.name }))];
  $("#tournamentTabs").innerHTML = opts.map((o) => `<button class="seg ${state.filterTournament === o.id ? "active" : ""}" data-tour="${o.id}">${esc(o.name)}</button>`).join("");
  $("#onlyUpcoming").setAttribute("aria-pressed", state.onlyUpcoming ? "true" : "false");
  $("#filters").hidden = false;
}

function filteredMatches() {
  const q = state.search.trim().toLowerCase(), now = Date.now();
  return state.matches.filter((m) => {
    if (state.personal && !involvesMyTeam(m) && !m.hypoMine) return false;
    if (state.filterTournament !== "all" && m.tournamentId !== state.filterTournament) return false;
    if (state.onlyUpcoming && (m.score.played || (m.ms != null && m.ms < now - LIVE_WINDOW_MIN * 60000))) return false;
    if (q && !`${m.team1} ${m.team2} ${m.tournament} ${m.stage}`.toLowerCase().includes(q)) return false;
    return true;
  });
}

function renderContent(now) {
  const root = $("#content");
  if (state.source === "fail") { root.innerHTML = `<div class="error">⚠️ Не удалось загрузить расписание.<br>Проверь интернет и нажми «Обновить».</div>`; return; }
  const list = filteredMatches();
  if (!list.length) { root.innerHTML = `<div class="empty">Ничего не найдено по текущим фильтрам.</div>` + renderBrackets() + renderStandings(); bindStandings(root); return; }

  const sorted = list.slice().sort((a, b) => (a.ms == null) - (b.ms == null) || (a.ms || 0) - (b.ms || 0));
  const groups = new Map();
  for (const m of sorted) { const k = dayKey(m); (groups.get(k) || groups.set(k, []).get(k)).push(m); }

  const todayKey = new Date(now + MSK_OFFSET * 3600000).toISOString().slice(0, 10);
  let html = "";
  for (const [k, ms] of groups) {
    html += `<section class="day"><div class="day-head"><h2>${esc(fmtDay(ms[0]))}</h2><span class="cnt">${ms.length}</span>${k === todayKey ? '<span class="badge-today">сегодня</span>' : ""}</div><div class="grid">${ms.map((m) => matchCard(m, now)).join("")}</div></section>`;
  }
  html += renderBrackets();
  html += renderStandings();
  root.innerHTML = html;
  bindStandings(root);
}

function bindStandings(root) {
  root.querySelectorAll(".standings-btn").forEach((b) => b.addEventListener("click", () => {
    const body = b.nextElementSibling; body.hidden = !body.hidden; b.querySelector(".chev").textContent = body.hidden ? "▾" : "▴";
  }));
}

function matchCard(m, now) {
  const st = matchStatus(m, now), sc = m.score;
  const realMine = state.personal && involvesMyTeam(m);
  const hypo = state.personal && m.hypoMine && !involvesMyTeam(m);
  const mine = realMine || hypo;
  // моя команда подставляется в гипотетический слот
  const h1 = hypo && m.hypoSide === 1, h2 = hypo && m.hypoSide === 2;
  const m1 = (state.personal && isMyTeam(m.tournamentId, m.team1)) || h1;
  const m2 = (state.personal && isMyTeam(m.tournamentId, m.team2)) || h2;
  const name1 = h1 ? m.hypoTeam : prettyTeam(m.team1);
  const name2 = h2 ? m.hypoTeam : prettyTeam(m.team2);
  const ct1 = h1 ? m.hypoTeam : (isPlaceholder(m.team1) ? "" : m.team1);
  const ct2 = h2 ? m.hypoTeam : (isPlaceholder(m.team2) ? "" : m.team2);
  const showPriority = realMine && st !== "finished";
  const skip = showPriority && m.skip;

  const won1 = sc.played && sc.a > sc.b, won2 = sc.played && sc.b > sc.a;
  const lose1 = sc.played && sc.a < sc.b, lose2 = sc.played && sc.b < sc.a;
  let scHtml;
  if (sc.played) scHtml = `<span class="sc"><span class="${won1 ? "w" : (lose1 ? "l" : "")}">${esc(sc.a)}</span><i>:</i><span class="${won2 ? "w" : (lose2 ? "l" : "")}">${esc(sc.b)}</span></span>`;
  else if (st === "live") scHtml = `<span class="sc live">LIVE</span>`;
  else scHtml = `<span class="sc vs">VS</span>`;

  const mark = '<span class="me-mark">Я</span>';
  let tag = "";
  if (skip) tag = `<span class="tag skip">⏭ замена · играю в ${esc(TOUR_SHORT[m.conflictWith.tournamentId] || "")}</span>`;
  else if (showPriority && m.clash) tag = `<span class="tag clash">⚠ накладка по времени</span>`;
  else if (hypo) tag = m.hypoVia === "WIN" ? `<span class="tag hypo">🔮 если пройду дальше</span>` : `<span class="tag hypo">🥉 если проиграю</span>`;
  else if (showPriority && realMine) tag = `<span class="tag play">★ мой матч</span>`;

  return `<article class="card ${mine ? "mine" : ""} ${hypo ? "hypo" : ""} ${st === "live" ? "is-live" : ""} ${skip ? "skip" : ""}">
    <div class="card-head">
      <span class="pill tour">${esc(TOUR_SHORT[m.tournamentId] || m.tournament)}</span>
      <span class="pill">${esc(m.stage)}</span>
      <span class="time">${esc(m.timeStr || "—")} <small>МСК</small></span>
    </div>
    <div class="row">
      <div class="side"><span class="mono" style="background:${teamColor(h1 ? m.hypoTeam : m.team1)}">${initials(h1 ? m.hypoTeam : m.team1)}</span><span class="nm ${h1 || !isPlaceholder(m.team1) ? "tname" : tbd(m.team1)} ${won1 ? "won" : ""} ${lose1 ? "lost" : ""}"${ct1 ? ` data-team="${esc(ct1)}"` : ""}>${esc(name1)}</span>${m1 ? mark : ""}</div>
      ${scHtml}
      <div class="side r"><span class="mono" style="background:${teamColor(h2 ? m.hypoTeam : m.team2)}">${initials(h2 ? m.hypoTeam : m.team2)}</span><span class="nm ${h2 || !isPlaceholder(m.team2) ? "tname" : tbd(m.team2)} ${won2 ? "won" : ""} ${lose2 ? "lost" : ""}"${ct2 ? ` data-team="${esc(ct2)}"` : ""}>${esc(name2)}</span>${m2 ? mark : ""}</div>
    </div>
    <div class="card-foot">${tag}${st !== "finished" ? streamLink(m.stream) : ""}${detailLink(m)}</div>
  </article>`;
}

function renderStandings() {
  let g = state.standings;
  if (state.filterTournament !== "all") g = g.filter((s) => s.tournamentId === state.filterTournament);
  if (!g.length) return "";
  const byKey = new Map();
  for (const s of g) { const k = s.tournamentId + "||" + s.group; if (!byKey.has(k)) byKey.set(k, { tid: s.tournamentId, tournament: s.tournament, group: s.group, rows: [] }); byKey.get(k).rows.push(s); }
  let body = "";
  for (const { tid, tournament, group, rows } of byKey.values()) {
    body += `<div class="stable"><h3>${esc(TOUR_SHORT[tid] || tournament)} · ${esc(group)}</h3><table>
      <thead><tr><th>#</th><th style="text-align:left">Команда</th><th>В</th><th>П</th><th>Карты</th><th>Очки</th></tr></thead>
      <tbody>${rows.map((r) => { const me = state.personal && isMyTeam(r.tournamentId, r.team); return `<tr class="${me ? "mine" : ""} ${r.place === "1" ? "lead" : ""}"><td class="p">${esc(r.place)}</td><td class="t"><span class="tname" data-team="${esc(r.team)}">${esc(r.team)}</span>${me ? ' <span class="me-mark">Я</span>' : ""}</td><td>${esc(r.w)}</td><td>${esc(r.l)}</td><td>${esc(r.maps)}</td><td>${esc(r.pts)}</td></tr>`; }).join("")}</tbody>
    </table></div>`;
  }
  return `<section class="standings"><button class="standings-btn">Турнирные таблицы (${byKey.size}) <span class="chev">▾</span></button><div class="standings-body" hidden>${body}</div></section>`;
}

/* ================= сетка плей-офф ================= */
function roundKey(ms) { return Math.min(...ms.map((m) => +m.num || 999)); }
function renderBrackets() {
  const tids = TOURNAMENTS.map((t) => t.id).filter((id) =>
    (state.filterTournament === "all" || state.filterTournament === id) &&
    state.matches.some((m) => m.tournamentId === id && isBracketStage(m.stage) && m.num));
  if (!tids.length) return "";
  let body = "";
  for (const tid of tids) {
    const bm = state.matches.filter((m) => m.tournamentId === tid && isBracketStage(m.stage) && m.num);
    const byStage = new Map();
    for (const m of bm) { if (!byStage.has(m.stage)) byStage.set(m.stage, []); byStage.get(m.stage).push(m); }
    const rounds = [...byStage.values()].map((ms) => ms.sort((a, b) => (+a.num) - (+b.num)))
      .sort((a, b) => roundKey(a) - roundKey(b));
    body += `<div class="bracket-tour"><h4>${esc(TOUR_SHORT[tid] || tid)}</h4>
      <div class="bracket">${rounds.map((ms) =>
        `<div class="bracket-col"><div class="bracket-round">${esc(ms[0].stage)}</div>${ms.map(bracketCard).join("")}</div>`).join("")}</div></div>`;
  }
  return `<section class="standings"><button class="standings-btn">🏆 Сетка плей-офф <span class="chev">▾</span></button><div class="standings-body" hidden>${body}</div></section>`;
}
function bxSide(m, side) {
  const raw = side === 1 ? m.team1 : m.team2, sc = m.score;
  const hyp = state.personal && m.hypoMine && m.hypoSide === side;
  const name = hyp ? m.hypoTeam : raw;
  const real = hyp ? m.hypoTeam : (isPlaceholder(raw) ? "" : raw);
  const me = state.personal && (isMyTeam(m.tournamentId, raw) || hyp);
  const won = sc.played && (side === 1 ? sc.a > sc.b : sc.b > sc.a);
  const num = sc.played ? (side === 1 ? sc.a : sc.b) : "";
  return `<div class="bx-team ${won ? "won" : ""} ${me ? "me" : ""}">
    <span class="${real ? "tname" : "tbd"}"${real ? ` data-team="${esc(real)}"` : ""}>${esc(prettyTeam(name))}</span>
    <b>${esc(num)}</b></div>`;
}
function bracketCard(m) {
  const hypo = state.personal && m.hypoMine && !involvesMyTeam(m);
  return `<div class="bx ${hypo ? "hypo" : ""}">${bxSide(m, 1)}${bxSide(m, 2)}</div>`;
}

/* ================= страница команды (модалка) ================= */
function computeTeamStats(team) {
  const ms = state.matches.filter((m) => m.team1 === team || m.team2 === team);
  const played = ms.filter((m) => m.score.played).sort((a, b) => (a.ms || 0) - (b.ms || 0));
  let w = 0, l = 0, mf = 0, ma = 0; const form = [];
  for (const m of played) {
    const t1 = m.team1 === team;
    const my = t1 ? m.score.a : m.score.b, op = t1 ? m.score.b : m.score.a;
    mf += my; ma += op; const win = my > op; win ? w++ : l++; form.push(win);
  }
  let streak = 0, sw = null;
  for (let i = form.length - 1; i >= 0; i--) { if (sw === null) { sw = form[i]; streak = 1; } else if (form[i] === sw) streak++; else break; }
  const upcoming = ms.filter((m) => !m.score.played && m.ms != null).sort((a, b) => a.ms - b.ms);
  return { team, n: played.length, w, l, mf, ma, wr: played.length ? Math.round(w / played.length * 100) : 0, form, streak, sw, played: played.reverse(), upcoming };
}
function openTeamModal(team) {
  const s = computeTeamStats(team);
  const tid = (s.played[0] || s.upcoming[0] || {}).tournamentId;
  const rowsUp = s.upcoming.map((m) => teamRow(m, team)).join("");
  const rowsPl = s.played.map((m) => teamRow(m, team)).join("");
  const formHtml = s.form.slice(-8).map((w) => `<span class="fdot ${w ? "w" : "l"}">${w ? "В" : "П"}</span>`).join("");
  const streakTxt = s.streak ? `${s.streak} ${s.sw ? "побед" : "поражений"} подряд` : "—";
  $("#modal .modal-card").innerHTML = `
    <button class="modal-close" aria-label="Закрыть">✕</button>
    <div class="modal-head">
      <span class="mono" style="background:${teamColor(team)}">${initials(team)}</span>
      <div><h3>${esc(prettyTeam(team))}</h3>${tid ? `<span class="modal-tour">${esc(TOUR_SHORT[tid] || "")}</span>` : ""}</div>
    </div>
    <div class="modal-stats">
      <div class="stat"><b>${s.w}–${s.l}</b><i>победы–поражения</i></div>
      <div class="stat"><b>${s.wr}%</b><i>винрейт</i></div>
      <div class="stat"><b>${s.mf}:${s.ma}</b><i>карты</i></div>
      <div class="stat"><b>${esc(streakTxt)}</b><i>серия</i></div>
    </div>
    ${s.form.length ? `<div class="modal-form">Форма: ${formHtml}</div>` : ""}
    ${rowsUp ? `<div class="modal-sec">Предстоящие</div><div class="modal-list">${rowsUp}</div>` : ""}
    ${rowsPl ? `<div class="modal-sec">Сыгранные</div><div class="modal-list">${rowsPl}</div>` : ""}`;
  $("#modal").hidden = false;
}
function teamRow(m, team) {
  const t1 = m.team1 === team, opp = t1 ? m.team2 : m.team1, sc = m.score;
  let res = "";
  if (sc.played) { const win = (t1 ? sc.a : sc.b) > (t1 ? sc.b : sc.a); res = `<span class="rdot ${win ? "w" : "l"}">${t1 ? sc.a : sc.b}:${t1 ? sc.b : sc.a}</span>`; }
  else res = `<span class="rdot vs">${esc(m.timeStr || "—")}</span>`;
  return `<div class="trow">
    <span class="trow-d">${esc(m.dateStr || "—")}</span>
    <span class="trow-o tname" data-team="${esc(opp)}">${esc(prettyTeam(opp))}</span>
    <span class="trow-t">${esc(TOUR_SHORT[m.tournamentId] || "")}</span>
    ${res}</div>`;
}
function closeModal() { const el = $("#modal"); if (el) el.hidden = true; }

function renderStatus() {
  const time = state.loadedAt ? state.loadedAt.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" }) : "—";
  const src = state.source === "snapshot" ? `<span class="snap">офлайн-копия</span>` : "данные актуальны";
  $("#statusLine").innerHTML = `Обновлено в ${time} · ${state.matches.length} матчей · ${src}`;
  const ll = $("#leagueLinks");
  if (ll) ll.innerHTML = `Лиги на Dotabuff: ` + TOURNAMENTS.filter((t) => t.dotabuff)
    .map((t) => `<a href="${esc(t.dotabuff)}" target="_blank" rel="noopener">${esc(TOUR_SHORT[t.id] || t.name)}</a>`).join(" · ");
}

/* ================= хелперы ================= */
function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
function tbd(name) { return isPlaceholder(name) ? "tbd" : ""; }
function initials(name) {
  const n = norm(name); if (isPlaceholder(n)) return "?";
  const clean = n.replace(/[^0-9A-Za-zА-Яа-яЁё ]/g, " ").trim(); if (!clean) return "?";
  const p = clean.split(/\s+/);
  return (p.length >= 2 ? (p[0][0] + p[1][0]) : clean.slice(0, 2)).toUpperCase();
}
function teamColor(name) {
  const n = norm(name);
  if (isPlaceholder(n) || !n) return "linear-gradient(140deg,#3a4250,#2a313c)";
  let h = 0; for (const ch of n) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const hue = h % 360;
  return `linear-gradient(140deg,hsl(${hue} 58% 50%),hsl(${(hue + 36) % 360} 56% 38%))`;
}
function streamLink(s) {
  s = norm(s); if (!s || /без трансл/i.test(s)) return "";
  const u = s.match(/https?:\/\/\S+/);
  return u ? `<a href="${esc(u[0])}" target="_blank" rel="noopener">📺 трансляция</a>` : `<span class="tag">📺 ${esc(s)}</span>`;
}
// ссылка на страницу конкретного матча (есть только у ЛЧБ) — и для сыгранных, и для будущих
function detailLink(m) {
  return m.url ? `<a href="${esc(m.url)}" target="_blank" rel="noopener">ℹ подробнее</a>` : "";
}

/* ================= таймер ================= */
function tick() {
  const el = document.querySelector(".hero-count");
  if (!el) return;
  const diff = +el.dataset.ms - Date.now();
  if (diff <= -LIVE_WINDOW_MIN * 60000) { render(); return; }
  if (diff <= 0) { el.textContent = "идёт"; el.classList.add("live"); el.classList.remove("soon"); return; }
  el.textContent = fmtCountdown(diff);
  el.classList.toggle("soon", diff < 3600000);
}

/* ================= живое обновление ================= */
async function refreshData() {
  if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
  // не дёргаем перерисовку, пока пользователь печатает в поиске
  if (typeof document !== "undefined" && document.activeElement && document.activeElement.id === "searchInput") return;
  await loadAll();
  render();
}

/* ================= события / старт ================= */
function bindEvents() {
  $("#myModeBtn").addEventListener("click", () => {
    state.personal = !state.personal;
    localStorage.setItem(STORAGE, state.personal ? "1" : "0");
    render();
  });
  $("#refreshBtn").addEventListener("click", async () => {
    const b = $("#refreshBtn"); b.classList.add("loading");
    await loadAll(); render(); b.classList.remove("loading");
  });
  $("#onlyUpcoming").addEventListener("click", () => { state.onlyUpcoming = !state.onlyUpcoming; render(); });
  $("#searchInput").addEventListener("input", (e) => { state.search = e.target.value; renderContent(Date.now()); });
  $("#tournamentTabs").addEventListener("click", (e) => { const b = e.target.closest(".seg"); if (b) { state.filterTournament = b.dataset.tour; render(); } });
  // клик по названию команды → страница команды
  document.addEventListener("click", (e) => {
    const t = e.target.closest("[data-team]");
    if (t) { openTeamModal(t.dataset.team); return; }
    if (e.target.closest(".modal-close") || e.target.id === "modal") closeModal();
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeModal(); });
}

async function init() {
  bindEvents();
  await loadAll();
  render();
  setInterval(tick, 1000);
  setInterval(refreshData, AUTO_REFRESH_MS);   // живое обновление данных
  if (typeof document !== "undefined" && document.addEventListener)
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") refreshData(); });
}
init();
