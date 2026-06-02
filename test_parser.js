/* Локальный тест парсера: прогоняем сохранённые CSV-снимки через parser.js. */
const fs = require("fs");
const path = require("path");
const P = require("./parser.js");

const FILES = [
  { f: "data/book1_dota_group.csv",   t: "Спартакиада Комус", d: "Групповой этап" },
  { f: "data/book1_dota_playoff.csv", t: "Спартакиада Комус", d: "Плей-офф" },
  { f: "data/book2_dota.csv",         t: "Сбер",              d: "Группы + плей-офф" },
];

let allMatches = [], allStandings = [];
for (const { f, t, d } of FILES) {
  const text = fs.readFileSync(path.join(__dirname, f), "utf8");
  const grid = P.parseCSV(text);
  const { matches, standings } = P.parseSheet(grid, { tournamentId: t, tournament: t, discipline: d });
  console.log(`\n=== ${f} ===  матчей: ${matches.length}, строк таблиц: ${standings.length}`);
  for (const m of matches.slice(0, 6)) {
    const dt = m.ms != null ? new Date(m.ms).toISOString() : "—";
    console.log(`  [${m.stage}] ${m.dateStr} ${m.timeStr} | ${P.prettyTeam(m.team1)} ${m.score.raw || "vs"} ${P.prettyTeam(m.team2)} | судья: ${m.judge} | dt=${dt}`);
  }
  allMatches.push(...matches);
  allStandings.push(...standings);
}

console.log(`\n===== ИТОГО =====`);
console.log(`Всего матчей: ${allMatches.length}`);
console.log(`Всего строк таблиц: ${allStandings.length}`);

const withDate = allMatches.filter((m) => m.ms != null).length;
console.log(`С распознанной датой/временем: ${withDate}/${allMatches.length}`);

const teams = new Set();
allMatches.forEach((m) => { [m.team1, m.team2].forEach((x) => { if (x && !P.isPlaceholder(x)) teams.add(x); }); });
console.log(`Уникальных команд: ${teams.size}`);
console.log("Команды:", [...teams].sort((a, b) => a.localeCompare(b, "ru")).join(", "));

// проверки целостности
const noTeams = allMatches.filter((m) => !m.team1 && !m.team2);
console.log(`\nМатчей без обеих команд (должно быть 0): ${noTeams.length}`);
const stages = [...new Set(allMatches.map((m) => m.stage))];
console.log("Стадии:", stages.join(" | "));
const groups = [...new Set(allStandings.map((s) => s.tournament + " · " + s.group))];
console.log("Таблицы:", groups.join(" | "));

// пример: следующий матч после фиксированной "сейчас"
const NOW = Date.UTC(2026, 5, 1, 9, 0); // 1 июня 2026 12:00 МСК
const next = allMatches
  .filter((m) => m.ms != null && m.ms >= NOW && !m.score.played && !P.isPlaceholder(m.team1) && !P.isPlaceholder(m.team2))
  .sort((a, b) => a.ms - b.ms)[0];
console.log("\nСледующий матч после 01.06 12:00 МСК:",
  next ? `${next.team1} vs ${next.team2} (${next.dateStr} ${next.timeStr}, ${next.tournament}/${next.stage})` : "нет");
