/* ===================================================================
   parser.js — чистая логика разбора Google-таблиц (без DOM).
   Подключается и в браузере (как глобальные функции), и в Node (module.exports)
   для тестов. Никаких обращений к window/document здесь быть не должно.
   =================================================================== */

"use strict";

const YEAR = 2026;          // год турниров
const MSK_OFFSET = 3;       // МСК = UTC+3
const SPLIT_COL = 12;       // таблицы лежат в две вертикальные полосы; правая начинается с этого столбца

const MONTHS = {
  "января": 1, "февраля": 2, "марта": 3, "апреля": 4, "мая": 5, "июня": 6,
  "июля": 7, "августа": 8, "сентября": 9, "октября": 10, "ноября": 11, "декабря": 12,
};

const norm = (s) => (s == null ? "" : String(s)).trim();

/* -------------------- CSV (кавычки, запятые, переносы внутри полей) -------------------- */
function parseCSV(text) {
  const rows = [];
  let row = [], field = "", inQ = false, i = 0;
  text = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  while (i < text.length) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQ = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"') { inQ = true; i++; continue; }
    if (c === ",") { row.push(field); field = ""; i++; continue; }
    if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; i++; continue; }
    field += c; i++;
  }
  row.push(field); rows.push(row);
  return rows;
}

/* -------------------- Поиск/детекторы столбцов -------------------- */
function findCol(row, start, end, pred) {
  for (let c = start; c < end; c++) if (pred(norm(row[c]))) return c;
  return -1;
}
function isScheduleHeader(row, b) {
  return findCol(row, b.start, b.end, (v) => v === "Дата") !== -1 &&
         findCol(row, b.start, b.end, (v) => /Команда\s*1/i.test(v)) !== -1;
}
function isStandingsHeader(row, b) {
  const hasTeam = findCol(row, b.start, b.end, (v) => v === "Команда") !== -1;
  const hasPts = findCol(row, b.start, b.end, (v) => v === "Очки" || /МЕСТО/i.test(v)) !== -1;
  return hasTeam && hasPts;
}
function blockBlank(row, b) {
  for (let c = b.start; c < b.end; c++) if (norm(row[c]) !== "") return false;
  return true;
}
function mapScheduleCols(row, b) {
  const dateC = findCol(row, b.start, b.end, (v) => v === "Дата");
  const end = Math.min(b.end, dateC + 13);
  return {
    date: dateC,
    time: findCol(row, dateC, end, (v) => /^Время/i.test(v)),
    round: findCol(row, dateC, end, (v) => v === "Раунд"),
    num: findCol(row, dateC, end, (v) => /встреч/i.test(v)),
    t1: findCol(row, dateC, end, (v) => /Команда\s*1/i.test(v)),
    score: findCol(row, dateC, end, (v) => /^Сч[её]т/i.test(v)),
    t2: findCol(row, dateC, end, (v) => /Команда\s*2/i.test(v)),
    judge: findCol(row, dateC, end, (v) => /Судья/i.test(v)),
    stream: findCol(row, dateC, end, (v) => /Трансляц/i.test(v)),
  };
}
function mapStandingsCols(row, b) {
  return {
    num: findCol(row, b.start, b.end, (v) => v === "№"),
    team: findCol(row, b.start, b.end, (v) => v === "Команда"),
    w: findCol(row, b.start, b.end, (v) => v === "В"),
    l: findCol(row, b.start, b.end, (v) => v === "П"),
    maps: findCol(row, b.start, b.end, (v) => v === "Карты"),
    pts: findCol(row, b.start, b.end, (v) => v === "Очки"),
    place: findCol(row, b.start, b.end, (v) => /МЕСТО/i.test(v)),
  };
}

function cleanStage(t) {
  t = norm(t);
  if (!t) return "";
  t = t.split(/\.?\s*Формат/i)[0].trim();           // отрезаем "Формат встреч ..."
  const g = t.match(/групп[аы]\s+([0-9A-Za-zА-Яа-яЁё]+)/i);
  if (g) return "Группа " + g[1].toUpperCase();
  t = t.replace(/^Расписание\s+/i, "").trim();
  return t;
}

/* -------------------- Разбор листа (две полосы) -------------------- */
function parseSheet(grid, ctx) {
  const matches = [], standings = [];
  const ncols = grid.reduce((m, r) => Math.max(m, r.length), 0);
  const blocks = [{ start: 0, end: SPLIT_COL }];
  if (ncols > SPLIT_COL) blocks.push({ start: SPLIT_COL, end: ncols });
  for (const block of blocks) parseBlock(grid, block, ctx, matches, standings);
  return { matches, standings };
}

function parseBlock(grid, b, ctx, matches, standings) {
  let mode = null, cols = null, stage = "";
  for (let r = 0; r < grid.length; r++) {
    const row = grid[r];

    if (isScheduleHeader(row, b)) { mode = "schedule"; cols = mapScheduleCols(row, b); continue; }
    if (isStandingsHeader(row, b)) { mode = "standings"; cols = mapStandingsCols(row, b); continue; }
    if (blockBlank(row, b)) { mode = null; cols = null; continue; }

    if (mode === "schedule" && cols) {
      const t1 = cols.t1 >= 0 ? norm(row[cols.t1]) : "";
      const t2 = cols.t2 >= 0 ? norm(row[cols.t2]) : "";
      if (!t1 && !t2) {                                 // строка-заголовок секции внутри расписания
        const titleCell = norm(row[b.start]);
        if (titleCell) stage = cleanStage(titleCell);
        continue;
      }
      const dateStr = cols.date >= 0 ? norm(row[cols.date]) : "";
      const timeStr = cols.time >= 0 ? norm(row[cols.time]) : "";
      const dt = parseDateTime(dateStr, timeStr);
      matches.push({
        tournamentId: ctx.tournamentId, tournament: ctx.tournament, discipline: ctx.discipline,
        stage: stage || ctx.discipline,
        round: cols.round >= 0 ? norm(row[cols.round]) : "",
        num: cols.num >= 0 ? norm(row[cols.num]) : "",
        dateStr, timeStr,
        ms: dt ? dt.getTime() : null,
        team1: t1, team2: t2,
        score: parseScore(cols.score >= 0 ? norm(row[cols.score]) : ""),
        judge: cols.judge >= 0 ? norm(row[cols.judge]) : "",
        stream: cols.stream >= 0 ? norm(row[cols.stream]) : "",
      });
      continue;
    }

    if (mode === "standings" && cols && cols.team >= 0) {
      const team = norm(row[cols.team]);
      if (!team) {
        const titleCell = norm(row[b.start]);
        if (titleCell && titleCell !== "№") stage = cleanStage(titleCell);
        continue;
      }
      standings.push({
        tournamentId: ctx.tournamentId, tournament: ctx.tournament,
        group: stage || "Таблица",
        place: cols.place >= 0 ? norm(row[cols.place]) : "",
        num: cols.num >= 0 ? norm(row[cols.num]) : "",
        team,
        w: cols.w >= 0 ? norm(row[cols.w]) : "",
        l: cols.l >= 0 ? norm(row[cols.l]) : "",
        maps: cols.maps >= 0 ? norm(row[cols.maps]) : "",
        pts: cols.pts >= 0 ? norm(row[cols.pts]) : "",
      });
      continue;
    }

    const titleCell = norm(row[b.start]);              // нет активной таблицы → это заголовок секции
    if (titleCell) stage = cleanStage(titleCell);
  }
}

/* -------------------- Дата / счёт / имена -------------------- */
function parseDateTime(dateStr, timeStr) {
  const d = norm(dateStr).toLowerCase();
  const m = d.match(/(\d{1,2})\s+([а-яё]+)/);
  if (!m) return null;
  const day = +m[1], mon = MONTHS[m[2]];
  if (!mon) return null;
  let hh = 0, mm = 0;
  const t = norm(timeStr).match(/(\d{1,2}):(\d{2})/);
  if (t) { hh = +t[1]; mm = +t[2]; }
  return new Date(Date.UTC(YEAR, mon - 1, day, hh - MSK_OFFSET, mm, 0)); // время трактуем как МСК
}
function parseScore(s) {
  s = norm(s);
  const m = s.match(/(\d+)\s*[:\-]\s*(\d+)/);
  if (!m) return { raw: s, played: false };
  return { raw: s, a: +m[1], b: +m[2], played: true };
}

const PLACEHOLDER_RE = /^(WIN|LOSE|WINNER|LOSER|Победитель|Проигравший)\b/i;
function isPlaceholder(name) { return PLACEHOLDER_RE.test(norm(name)); }
function prettyTeam(name) {
  const n = norm(name);
  let m = n.match(/^WIN\s*(\d+)/i);
  if (m) return "Победитель встречи " + m[1];
  m = n.match(/^LOSE\s*(\d+)/i);
  if (m) return "Проигравший встречи " + m[1];
  return n;
}

/* -------------------- экспорт для Node-тестов -------------------- */
if (typeof module !== "undefined" && module.exports) {
  module.exports = { parseCSV, parseSheet, parseDateTime, parseScore, isPlaceholder, prettyTeam, cleanStage, MSK_OFFSET, YEAR };
}
