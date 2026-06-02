# -*- coding: utf-8 -*-
"""
scrape_lchb.py — сборщик расписания ЛЧБ (Лига Чемпионов Бизнеса), лига Изумруд.

Сайт ЛЧБ не отдаёт CORS, поэтому браузер не может читать его напрямую.
Этот скрипт скачивает страницы ЛЧБ, парсит лигу Изумруд (расписание группы,
плей-офф, таблицу) и кладёт результат в data/lchb.json, который читает сайт.

Запуск:
    python scrape_lchb.py
(нужны пакеты requests и beautifulsoup4)
"""
import json
import re
import sys
from datetime import datetime, timezone, timedelta
from pathlib import Path

import requests
from bs4 import BeautifulSoup

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

ROOT = "https://dota.businesschampionsleague.com"
BASE = ROOT + "/vesna-2026"
STREAM_RE = re.compile(r"twitch\.tv|youtube\.com|youtu\.be|vkplay|vkvideo|vk\.com/video|trovo|kick\.com", re.I)
MATCH_RE = re.compile(r"/matches/\d+")
LEAGUE = "Изумруд"            # человекочитаемое имя лиги (в .match-score__competition)
LEAGUE_SLUG = "izumrud"
MY_TEAM = "TeamSpirt"
MSK = timezone(timedelta(hours=3))

MONTHS_RU = ["", "января", "февраля", "марта", "апреля", "мая", "июня",
             "июля", "августа", "сентября", "октября", "ноября", "декабря"]

OUT = Path(__file__).parent / "data" / "lchb.json"


def fetch(url):
    r = requests.get(url, timeout=45, headers={"User-Agent": "Mozilla/5.0 (lchb-scraper)"})
    r.raise_for_status()
    r.encoding = "utf-8"
    return r.text


def parse_dt(text):
    """'18.04.2026 11:00' -> (epoch_ms в МСК, 'DD месяца', 'HH:MM')."""
    m = re.search(r"(\d{1,2})\.(\d{1,2})\.(\d{4})\s+(\d{1,2}):(\d{2})", text or "")
    if not m:
        m2 = re.search(r"(\d{1,2})\.(\d{1,2})\.(\d{4})", text or "")
        if not m2:
            return None, "", ""
        d, mo, y = int(m2[1]), int(m2[2]), int(m2[3])
        dt = datetime(y, mo, d, 0, 0, tzinfo=MSK)
        return int(dt.timestamp() * 1000), f"{d} {MONTHS_RU[mo]}", ""
    d, mo, y, hh, mm = (int(m[i]) for i in range(1, 6))
    dt = datetime(y, mo, d, hh, mm, tzinfo=MSK)
    return int(dt.timestamp() * 1000), f"{d} {MONTHS_RU[mo]}", f"{hh:02d}:{mm:02d}"


def team_nick(fig):
    """Достаём ник команды из блока .match-team."""
    nik = fig.find(class_="match-team__nik")
    if nik and nik.get_text(strip=True):
        return nik.get_text(strip=True)
    name = fig.find(class_="match-team__name")
    return name.get_text(strip=True) if name else "?"


def clean_competition(text):
    """'Группа A [Изумруд]' -> ('Группа A', 'Изумруд')."""
    text = re.sub(r"\s+", " ", text or "").strip()
    mm = re.search(r"\[([^\]]+)\]", text)
    league = mm.group(1).strip() if mm else ""
    stage = re.sub(r"\s*\[[^\]]*\]\s*", "", text).strip()
    return stage or "Группа", league


def parse_score(text):
    text = re.sub(r"\s+", "", text or "")
    m = re.match(r"(\d+):(\d+)", text)
    if not m:
        return "", False
    return f"{m[1]}:{m[2]}", True


def parse_matches(html, stage_prefix=""):
    soup = BeautifulSoup(html, "html.parser")
    out = []
    for block in soup.find_all(class_="match-score"):
        comp_el = block.find(class_="match-score__competition")
        stage, league = clean_competition(comp_el.get_text(" ", strip=True) if comp_el else "")
        if league and LEAGUE.lower() not in league.lower():
            continue
        if not league and LEAGUE.lower() not in (comp_el.get_text(strip=True).lower() if comp_el else ""):
            # на странице плей-офф лига может не дублироваться в каждом блоке — берём всё
            if stage_prefix == "":
                continue
        teams = block.find_all(class_="match-team")
        if len(teams) < 2:
            continue
        t1, t2 = team_nick(teams[0]), team_nick(teams[1])
        sc_el = block.find(class_="match-result__score")
        score, played = parse_score(sc_el.get_text(" ", strip=True) if sc_el else "")
        date_el = block.find(class_="match-score__date") or block.find(class_="date")
        ms, date_str, time_str = parse_dt(date_el.get_text(" ", strip=True) if date_el else "")
        # трансляция (twitch и т.п.) и ссылка на страницу матча
        scope = [block] + ([block.parent] if block.parent else [])
        stream = ""
        murl = ""
        for sc in scope:
            if not stream:
                a = sc.find("a", href=STREAM_RE)
                if a:
                    stream = a["href"]
            if not murl:
                a = sc.find("a", href=MATCH_RE)
                if a:
                    href = a["href"]
                    murl = href if href.startswith("http") else ROOT + href
        out.append({
            "ms": ms, "dateStr": date_str, "timeStr": time_str,
            "stage": (stage_prefix + stage) if stage_prefix else stage,
            "team1": t1, "team2": t2, "score": score, "played": played,
            "stream": stream, "url": murl,
        })
    return out


def parse_standings(html):
    """Турнирная таблица группы, в которой играет моя команда (надёжнее, чем гадать по лиге)."""
    soup = BeautifulSoup(html, "html.parser")
    for t in soup.find_all("table", class_="standings-table"):
        niks = [n.get_text(strip=True) for n in t.find_all(class_="match-team__nik")]
        if MY_TEAM not in niks:
            continue
        head = t.find_previous(["h2", "h3", "h4"])
        group, _ = clean_competition(head.get_text(" ", strip=True) if head else "")
        rows_out = []
        body = t.find("tbody")
        for tr in (body.find_all("tr") if body else []):
            tds = tr.find_all("td")
            if len(tds) < 3:
                continue
            team_el = tr.find(class_="match-team__nik") or tr.find(class_="match-team__name")
            team = team_el.get_text(strip=True) if team_el else tds[1].get_text(strip=True)
            nums = [td.get_text(strip=True) for td in tds[-5:]]  # И В П Геймы Очки
            rows_out.append({
                "group": group or "Группа",
                "place": tds[0].get_text(strip=True),
                "team": team,
                "games": nums[0] if len(nums) > 0 else "",
                "w": nums[1] if len(nums) > 1 else "",
                "l": nums[2] if len(nums) > 2 else "",
                "maps": nums[3] if len(nums) > 3 else "",
                "pts": nums[4] if len(nums) > 4 else "",
            })
        return rows_out
    return []


def main():
    print(f"Скачиваю ЛЧБ (лига {LEAGUE})…")
    sched_html = fetch(f"{BASE}/schedule-group/")
    matches = parse_matches(sched_html)
    print(f"  матчей группы Изумруд: {len(matches)}")

    try:
        po_html = fetch(f"{BASE}/playoff-schemes/?league={LEAGUE_SLUG}")
        po = parse_matches(po_html, stage_prefix="Плей-офф · ")
        # на странице плей-офф все блоки уже относятся к выбранной лиге
        print(f"  матчей плей-офф: {len(po)}")
        matches += po
    except Exception as e:
        print("  плей-офф пропущен:", e)

    try:
        tbl_html = fetch(f"{BASE}/tables/")
        standings = parse_standings(tbl_html)
        print(f"  строк таблицы: {len(standings)}")
    except Exception as e:
        standings = []
        print("  таблица пропущена:", e)

    # дедуп по (ms, team1, team2)
    seen, uniq = set(), []
    for m in matches:
        key = (m["ms"], m["team1"], m["team2"])
        if key in seen:
            continue
        seen.add(key)
        uniq.append(m)
    uniq.sort(key=lambda m: (m["ms"] is None, m["ms"] or 0))

    data = {
        "tournament": "ЛЧБ · Весна 2026",
        "league": LEAGUE,
        "team": MY_TEAM,
        "generatedAt": datetime.now(MSK).isoformat(),
        "matches": uniq,
        "standings": standings,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Готово -> {OUT} ({len(uniq)} матчей, {len(standings)} строк таблицы)")

    mine = [m for m in uniq if MY_TEAM in (m["team1"], m["team2"])]
    print(f"\nМои матчи ({MY_TEAM}): {len(mine)}")
    for m in mine:
        sc = m["score"] or "—"
        print(f"  {m['dateStr']} {m['timeStr']} [{m['stage']}] {m['team1']} {sc} {m['team2']}")


if __name__ == "__main__":
    sys.exit(main())
