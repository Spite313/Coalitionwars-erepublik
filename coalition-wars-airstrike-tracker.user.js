// ==UserScript==
// @name         eRepublik - Coalition Wars + Airstrike Tracker
// @namespace    http://tampermonkey.net/
// @version      4.1
// @description  Coalition battles (with live scores) plus airstrike-law cooldown tracker. Floating box on desktop, docked panel on mobile.
// @author       You
// @match        https://www.erepublik.com/en
// @match        https://www.erepublik.com/en/
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @connect      www.erepublik.com
// @run-at       document-end
// ==/UserScript==

(function () {
    'use strict';

    /******************************************************************
     * PAGE GUARD - only run on the exact homepage (https://www.erepublik.com/en)
     ******************************************************************/
    if (
        location.hostname !== "www.erepublik.com" ||
        !(location.pathname === "/en" || location.pathname === "/en/")
    ) {
        return;
    }

    /******************************************************************
     * CONFIGURATION - WARS
     ******************************************************************/
    const DEBUG = false;
    const DEBUG_BATTLE_ID = null;

    const REFRESH_MIN_MS = 4 * 60 * 1000;
    const REFRESH_MAX_MS = 6 * 60 * 1000;
    // Bumped to v2 so old cached data without scores isn't reused
    const CACHE_KEY = "cw-campaign-cache-v2";

    const SIDE_1_IDS = new Set([
        "42", "79", "53", "29", "171", "65", "13", "61", "63", "50", "74", "41", "69"
        // Bulgaria, N.Macedonia, Portugal, UK, Cuba, Serbia, Hungary, Slovenia,
        // Croatia, Australia, Uruguay, Russia, Bosnia
    ]);

    const SIDE_2_IDS = new Set([
        "1", "72", "40", "166", "59", "24", "83", "38", "71", "164", "82", "43", "80", "44"
        // Romania, Lithuania, Ukraine, UAE, Thailand, USA, Belarus, Sweden,
        // Latvia, Saudi Arabia, Cyprus, Turkey, Montenegro, Greece
    ]);

    const COUNTRY_NAMES = {
        "1": "Romania", "9": "Brazil", "10": "Italy", "11": "France", "12": "Germany",
        "13": "Hungary", "14": "China", "15": "Spain", "23": "Canada", "24": "USA",
        "26": "Mexico", "27": "Argentina", "28": "Venezuela", "29": "United Kingdom",
        "30": "Switzerland", "31": "Netherlands", "32": "Belgium", "33": "Austria",
        "34": "Czech Republic", "35": "Poland", "36": "Slovakia", "37": "Norway",
        "38": "Sweden", "39": "Finland", "40": "Ukraine", "41": "Russia", "42": "Bulgaria",
        "43": "Turkey", "44": "Greece", "45": "Japan", "47": "South Korea", "48": "India",
        "49": "Indonesia", "50": "Australia", "51": "South Africa", "52": "Moldova",
        "53": "Portugal", "54": "Ireland", "55": "Denmark", "56": "Iran", "57": "Pakistan",
        "58": "Israel", "59": "Thailand", "61": "Slovenia", "63": "Croatia", "64": "Chile",
        "65": "Serbia", "66": "Malaysia", "67": "Philippines", "68": "Singapore",
        "69": "Bosnia", "70": "Estonia", "71": "Latvia", "72": "Lithuania",
        "73": "North Korea", "74": "Uruguay", "75": "Paraguay", "76": "Bolivia",
        "77": "Peru", "78": "Colombia", "79": "North Macedonia", "80": "Montenegro",
        "81": "Taiwan", "82": "Cyprus", "83": "Belarus", "84": "New Zealand",
        "164": "Saudi Arabia", "165": "Egypt", "166": "UAE", "167": "Albania",
        "168": "Georgia", "169": "Armenia", "170": "Nigeria", "171": "Cuba"
    };

    /******************************************************************
     * CONFIGURATION - AIRSTRIKES
     ******************************************************************/
    // Allies/enemies are taken from SIDE_1_IDS / SIDE_2_IDS above, plus these
    // extras (Paraguay is on your ally list but not in the wars list).
    const AIR_EXTRA_SIDE_1 = ["75"];
    const AIR_EXTRA_SIDE_2 = [];

    // country id -> URL name used on country-administration pages
    const AIR_SLUGS = {
        "42": "Bulgaria", "79": "North-Macedonia", "53": "Portugal", "29": "United-Kingdom",
        "171": "Cuba", "65": "Serbia", "13": "Hungary", "61": "Slovenia", "63": "Croatia",
        "50": "Australia", "74": "Uruguay", "41": "Russia", "69": "Bosnia-Herzegovina",
        "75": "Paraguay",
        "1": "Romania", "72": "Lithuania", "40": "Ukraine", "166": "United-Arab-Emirates",
        "59": "Thailand", "24": "USA", "83": "Belarus", "38": "Sweden", "71": "Latvia",
        "164": "Saudi-Arabia", "82": "Cyprus", "43": "Turkey", "80": "Montenegro", "44": "Greece"
    };

    const AIR_COOLDOWN_DAYS = 14;      // airstrike available this long after the law passed
    const AIR_VOTE_HOURS = 24;         // vote lasts 24h; a passed law counts as passed at proposal + 24h
    const AIR_MAX_PAGES = 8;           // max list pages scanned per country (10 laws per page)
    const AIR_DELAY_MS = 1300;         // base pause between requests (+ random jitter)
    const AIR_DAY_START_HOUR = 10;     // eRepublik day change, Bucharest local time
    const AIR_EPOCH = [2007, 10, 21];  // eRepublik day 1 = 21 Nov 2007 (month is 0-based)
    const AIR_STORE_RESULTS = "cw-air-results-v1";
    const AIR_STORE_UPDATED = "cw-air-updated-v1";

    const MOBILE_QUERY = "(max-width: 800px)";

    /******************************************************************
     * BASIC HELPERS
     ******************************************************************/
    function debug(...args) {
        if (DEBUG) console.log("[Coalition Wars]", ...args);
    }

    function normaliseId(value) {
        if (value === undefined || value === null) return null;
        if (typeof value === "object") {
            if (value.id !== undefined) return normaliseId(value.id);
            if (value.country_id !== undefined) return normaliseId(value.country_id);
            if (value.countryId !== undefined) return normaliseId(value.countryId);
            return null;
        }
        const result = String(value).trim();
        return result ? result : null;
    }

    function checkSide(id) {
        const n = normaliseId(id);
        if (!n) return 0;
        if (SIDE_1_IDS.has(n)) return 1;
        if (SIDE_2_IDS.has(n)) return 2;
        return 0;
    }

    function getCountryName(id, fallback = null) {
        const n = normaliseId(id);
        if (n && COUNTRY_NAMES[n]) return COUNTRY_NAMES[n];
        if (fallback) return fallback;
        if (n) return "Country #" + n;
        return "Unknown";
    }

    function escapeHTML(value) {
        return String(value ?? "")
            .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;").replace(/'/g, "&#039;");
    }

    function firstDefined(...values) {
        for (const v of values) {
            if (v !== undefined && v !== null && v !== "") return v;
        }
        return null;
    }

    const sleep = ms => new Promise(r => setTimeout(r, ms));

    function safeGet(key, def) {
        try {
            if (typeof GM_getValue !== "function") return def;
            const v = GM_getValue(key, def);
            return v === undefined ? def : v;
        } catch (e) { return def; }
    }

    function safeSet(key, value) {
        try {
            if (typeof GM_setValue === "function") GM_setValue(key, value);
        } catch (e) { /* ignore */ }
    }

    /******************************************************************
     * COUNTRY / BATTLE EXTRACTION (WARS)
     ******************************************************************/
    function extractCountryId(value) {
        if (value === undefined || value === null) return null;
        if (typeof value === "string" || typeof value === "number") {
            const id = normaliseId(value);
            return id && /^\d+$/.test(id) ? id : null;
        }
        if (typeof value === "object") {
            const directId = firstDefined(value.id, value.country_id, value.countryId, value.countryID);
            if (directId !== null) return normaliseId(directId);
            if (value.country) {
                const nested = extractCountryId(value.country);
                if (nested) return nested;
            }
        }
        return null;
    }

    function extractCountryName(value) {
        if (value === undefined || value === null) return null;
        if (typeof value === "object") {
            const name = firstDefined(value.name, value.country_name, value.countryName, value.display_name, value.title);
            if (name) return String(name);
            if (value.country) return extractCountryName(value.country);
        }
        return null;
    }

    function extractBattleId(battle) {
        if (!battle || typeof battle !== "object") return null;
        return normaliseId(firstDefined(battle.id, battle.id_battle, battle.battle_id, battle.battleId, battle.battleID));
    }

    function extractRegionName(battle, battleId) {
        const direct = firstDefined(battle.region_name, battle.regionName, battle.region_title, battle.regionTitle, battle.location_name);
        if (direct) return String(direct);
        if (battle.region) {
            if (typeof battle.region === "string") return battle.region;
            if (typeof battle.region === "object") {
                const name = firstDefined(battle.region.name, battle.region.region_name, battle.region.title);
                if (name) return String(name);
            }
        }
        return "Battle #" + (battleId || "?");
    }

    // Battle-level score for one side (battle.inv.points / battle.def.points)
    function extractPoints(side) {
        if (!side || typeof side !== "object") return null;
        const n = Number(side.points);
        return Number.isFinite(n) ? n : null;
    }

    function extractAttacker(battle) {
        const candidates = [
            battle.inv, battle.attacker, battle.invader, battle.attacking_country,
            battle.attackingCountry, battle.attacker_country, battle.invader_country
        ];
        for (const c of candidates) {
            const id = extractCountryId(c);
            if (id) return { id, name: extractCountryName(c) || getCountryName(id) };
        }
        const id = firstDefined(
            battle.attacker_country_id, battle.attacking_country_id, battle.invader_country_id,
            battle.inv_id, battle.inv_country_id, battle.attacker_id, battle.attackerId
        );
        if (id !== null) {
            const countryId = normaliseId(id);
            return {
                id: countryId,
                name: firstDefined(
                    battle.attacker_name, battle.attacking_country_name, battle.invader_name,
                    battle.inv_name, getCountryName(countryId)
                )
            };
        }
        return null;
    }

    function extractDefender(battle) {
        const candidates = [
            battle.def, battle.defender, battle.defending_country,
            battle.defendingCountry, battle.defender_country
        ];
        for (const c of candidates) {
            const id = extractCountryId(c);
            if (id) return { id, name: extractCountryName(c) || getCountryName(id) };
        }
        const id = firstDefined(
            battle.defender_country_id, battle.defending_country_id, battle.def_id,
            battle.def_country_id, battle.defender_id, battle.defenderId
        );
        if (id !== null) {
            const countryId = normaliseId(id);
            return {
                id: countryId,
                name: firstDefined(
                    battle.defender_name, battle.defending_country_name, battle.def_name,
                    getCountryName(countryId)
                )
            };
        }
        return null;
    }

    function isResistanceWar(battle) {
        if (!battle || typeof battle !== "object") return false;
        const values = [
            battle.is_rw, battle.is_resistance, battle.resistance,
            battle.resistance_war, battle.isResistance, battle.isResistanceWar
        ];
        for (const v of values) {
            if (v === true || v === 1 || v === "1" || v === "true") return true;
        }
        const typeValues = [battle.type, battle.special_type, battle.battle_type, battle.war_type];
        for (const v of typeValues) {
            if (!v) continue;
            const text = String(v).toLowerCase();
            if (text === "rw" || text.includes("resistance")) return true;
        }
        const invaderId = firstDefined(battle.inv_country_id, battle.inv_id, battle.invader_country_id);
        if (invaderId !== null && normaliseId(invaderId) === "0") return true;
        return false;
    }

    function extractResistanceDefender(battle) {
        const candidates = [
            battle.def, battle.occupier, battle.occupied_country, battle.occupiedCountry,
            battle.defender, battle.defending_country, battle.defendingCountry
        ];
        for (const c of candidates) {
            const id = extractCountryId(c);
            if (id) return { id, name: extractCountryName(c) || getCountryName(id) };
        }
        const id = firstDefined(
            battle.occ_country_id, battle.occupier_country_id, battle.occupied_country_id,
            battle.occupiedCountryId, battle.def_country_id, battle.defender_country_id,
            battle.def_id, battle.defender_id
        );
        if (id !== null) {
            const countryId = normaliseId(id);
            return {
                id: countryId,
                name: firstDefined(
                    battle.occ_name, battle.occupier_name, battle.occupied_country_name,
                    battle.def_name, getCountryName(countryId)
                )
            };
        }
        if (battle.countries && typeof battle.countries === "object") {
            for (const [key, country] of Object.entries(battle.countries)) {
                if (!country || typeof country !== "object") continue;
                const role = String(firstDefined(country.type, country.side, country.role) || "").toLowerCase();
                const markedDefender = country.is_defender == 1 || country.is_defender === true || role === "defender" || role === "def";
                const markedOccupier = country.is_occupier == 1 || country.is_occupier === true || role === "occupier";
                if (markedDefender || markedOccupier) {
                    const countryId = extractCountryId(country) || (/^\d+$/.test(key) ? key : null);
                    if (countryId) {
                        return { id: countryId, name: extractCountryName(country) || getCountryName(countryId) };
                    }
                }
            }
        }
        return null;
    }

    function extractResistanceAttacker(battle) {
        const candidates = [
            battle.inv, battle.resistance, battle.resistance_country,
            battle.liberator, battle.original_owner
        ];
        for (const c of candidates) {
            const id = extractCountryId(c);
            if (id) return { id, name: extractCountryName(c) || getCountryName(id) };
        }
        const id = firstDefined(battle.inv_country_id, battle.inv_id, battle.resistance_country_id);
        if (id !== null) {
            const countryId = normaliseId(id);
            return {
                id: countryId,
                name: firstDefined(battle.inv_name, battle.resistance_name, getCountryName(countryId))
            };
        }
        return null;
    }

    function getBattleArray(data) {
        if (!data) return [];
        if (Array.isArray(data)) return data;
        const candidates = [data.battles, data.campaigns, data.list, data.results, data.items, data.data];
        for (const c of candidates) {
            if (Array.isArray(c)) return c;
            if (c && typeof c === "object") return Object.values(c);
        }
        if (typeof data === "object") {
            const values = Object.values(data).filter(v => v && typeof v === "object");
            const likely = values.filter(v =>
                extractBattleId(v) || v.region || v.region_name || v.attacker ||
                v.defender || v.invader || v.inv_country_id
            );
            if (likely.length) return likely;
        }
        return [];
    }

    function parseDirectWars(battlesList) {
        const results = [];
        for (const battle of battlesList) {
            if (!battle || typeof battle !== "object") continue;
            if (isResistanceWar(battle)) continue;
            const battleId = extractBattleId(battle);
            if (!battleId) continue;
            const attacker = extractAttacker(battle);
            const defender = extractDefender(battle);
            if (!attacker || !defender) {
                debug("Could not identify attacker/defender:", battle);
                continue;
            }
            const attackerSide = checkSide(attacker.id);
            const defenderSide = checkSide(defender.id);
            const cross =
                (attackerSide === 1 && defenderSide === 2) ||
                (attackerSide === 2 && defenderSide === 1);
            if (!cross) continue;
            results.push({
                id: battleId,
                region: extractRegionName(battle, battleId),
                invader: attacker.name,
                defender: defender.name,
                attackerSide,
                defenderSide,
                invPoints: extractPoints(battle.inv),
                defPoints: extractPoints(battle.def)
            });
        }
        return results;
    }

    function parseResistanceWars(battlesList) {
        const results = [];
        for (const battle of battlesList) {
            if (!battle || typeof battle !== "object") continue;
            if (!isResistanceWar(battle)) continue;
            const battleId = extractBattleId(battle);
            if (!battleId) continue;
            const occupier = extractResistanceDefender(battle);
            const resistance = extractResistanceAttacker(battle);
            if (!occupier && !resistance) {
                debug("Resistance war found but neither side could be identified:", battle);
                continue;
            }
            const occupierSide = occupier ? checkSide(occupier.id) : 0;
            const resistanceSide = resistance ? checkSide(resistance.id) : 0;
            if (occupierSide !== 1 && occupierSide !== 2 && resistanceSide !== 1 && resistanceSide !== 2) continue;
            results.push({
                id: battleId,
                region: extractRegionName(battle, battleId),
                occupier: occupier ? occupier.name : "Unknown",
                occupierSide,
                resistance: resistance ? resistance.name : "Unknown",
                resistanceSide,
                defender: occupier ? occupier.name : "Unknown",
                defendingSide: occupierSide,
                // In RWs, inv = resistance side, def = occupier
                resistancePoints: extractPoints(battle.inv),
                occupierPoints: extractPoints(battle.def)
            });
        }
        return results;
    }

    function uniqueByBattleId(list) {
        const seen = new Set();
        const result = [];
        for (const item of list) {
            if (!item || !item.id) continue;
            const id = String(item.id);
            if (seen.has(id)) continue;
            seen.add(id);
            result.push(item);
        }
        return result;
    }

    /******************************************************************
     * AIRSTRIKES - TIME HELPERS (Bucharest, DST-aware)
     ******************************************************************/
    const HOUR = 3600e3;
    const DAY = 864e5;

    function bucharestOffsetMs(ms) {
        const f = new Intl.DateTimeFormat("en-GB", {
            timeZone: "Europe/Bucharest", hourCycle: "h23",
            year: "numeric", month: "2-digit", day: "2-digit",
            hour: "2-digit", minute: "2-digit", second: "2-digit"
        });
        const p = {};
        f.formatToParts(new Date(ms)).forEach(x => (p[x.type] = x.value));
        const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
        return asUtc - (ms - (ms % 1000));
    }

    // UTC ms at which eRepublik day n begins
    function dayStartMs(n) {
        const fakeLocal = Date.UTC(AIR_EPOCH[0], AIR_EPOCH[1], AIR_EPOCH[2] + n - 1, AIR_DAY_START_HOUR);
        let utc = fakeLocal - bucharestOffsetMs(fakeLocal);
        utc = fakeLocal - bucharestOffsetMs(utc);
        return utc;
    }

    function currentErepDay() {
        const now = Date.now();
        const local = now + bucharestOffsetMs(now);
        return Math.floor(
            (local - AIR_DAY_START_HOUR * HOUR - Date.UTC(AIR_EPOCH[0], AIR_EPOCH[1], AIR_EPOCH[2])) / DAY
        ) + 1;
    }

    function fmtDuration(ms) {
        if (ms < 0) ms = 0;
        const d = Math.floor(ms / DAY);
        const h = Math.floor((ms % DAY) / HOUR);
        const m = Math.floor((ms % HOUR) / 60000);
        if (d > 0) return d + "d " + h + "h";
        if (h > 0) return h + "h " + m + "m";
        return m + "m";
    }

    /******************************************************************
     * AIRSTRIKES - FETCHING / PARSING
     ******************************************************************/
    async function getDoc(url) {
        const r = await fetch(url, { credentials: "include" });
        if (!r.ok) throw new Error("HTTP " + r.status);
        return new DOMParser().parseFromString(await r.text(), "text/html");
    }

    // Reads the law list table: each row has the law type, "Day N, HH:MM" and a status icon (alt text).
    function parseListRows(doc) {
        const rows = [];
        doc.querySelectorAll("tr").forEach(tr => {
            const a = tr.querySelector('a[href*="/main/law/"]');
            if (!a) return;
            const idm = (a.getAttribute("href") || "").match(/\/main\/law\/[^\/]+\/(\d+)/);
            const tm = (tr.textContent || "").match(/Day\s*([\d,]+),\s*(\d{1,2}):(\d{2})/);
            if (!idm || !tm) return;
            const day = parseInt(tm[1].replace(/,/g, ""), 10);
            const proposed = dayStartMs(day) + (parseInt(tm[2], 10) * 60 + parseInt(tm[3], 10)) * 60000;
            const icon = tr.querySelector("img.icon");
            const st = ((icon && icon.getAttribute("alt")) || "").toLowerCase();
            let status = "voting";
            if (st.indexOf("accept") !== -1) status = "passed";
            else if (st.indexOf("reject") !== -1) status = "rejected";
            const label = (a.textContent || "").trim() + " " + (a.className || "");
            rows.push({
                id: +idm[1],
                isAirstrike: /airstrike/i.test(label),
                status,
                proposed
            });
        });
        return rows;
    }

    async function scanCountry(slug) {
        // Stop looking once laws are older than this: nothing older can still block an airstrike
        const cutoff = Date.now() - (AIR_COOLDOWN_DAYS + AIR_VOTE_HOURS / 24 + 1) * DAY;
        const seen = new Set();

        for (let page = 1; page <= AIR_MAX_PAGES; page++) {
            if (page > 1) await sleep(AIR_DELAY_MS + Math.random() * 500);
            const doc = await getDoc(`/en/country-administration/${slug}/${page}`);
            const rows = parseListRows(doc).filter(r => !seen.has(r.id));

            if (!rows.length) {
                return page === 1 ? { error: "no laws found on list page" } : { none: true };
            }

            for (const r of rows) {
                seen.add(r.id);
                if (r.isAirstrike) return { id: r.id, status: r.status, proposed: r.proposed };
            }
            // rows are newest-first: if the oldest law on this page is past the cutoff, no airstrike is blocking
            if (rows[rows.length - 1].proposed < cutoff) return { none: true };
        }
        return { error: "gave up scanning (too many laws)" };
    }

    /******************************************************************
     * AIRSTRIKES - STATE
     ******************************************************************/
    let airResults = {};
    try { airResults = JSON.parse(safeGet(AIR_STORE_RESULTS, "{}")) || {}; } catch (e) { airResults = {}; }
    let airBusy = false;

    function airIds(side) {
        const base = side === 1 ? [...SIDE_1_IDS, ...AIR_EXTRA_SIDE_1] : [...SIDE_2_IDS, ...AIR_EXTRA_SIDE_2];
        return [...new Set(base)].filter(id => AIR_SLUGS[id]);
    }

    function describeAir(r) {
        const now = Date.now();
        if (!r) return { cls: "unk", text: "—", rank: 3, at: Infinity, title: "not loaded yet" };
        if (r.error) return { cls: "unk", text: "?", rank: 3, at: Infinity, title: r.error };
        if (r.none) return { cls: "ready", text: "Ready", rank: 1, at: 0, title: "no airstrike law in the last ~16 days" };
        const voteEnd = r.proposed + AIR_VOTE_HOURS * HOUR;
        if (r.status === "voting") {
            return voteEnd > now
                ? { cls: "vote", text: "Vote " + fmtDuration(voteEnd - now), rank: 0, at: voteEnd, title: "airstrike vote in progress" }
                : { cls: "vote", text: "Vote ended", rank: 0, at: voteEnd, title: "vote should have finished - refresh" };
        }
        if (r.status === "rejected") return { cls: "ready", text: "Ready", rank: 1, at: 0, title: "last airstrike proposal was rejected" };
        const at = voteEnd + AIR_COOLDOWN_DAYS * DAY;
        if (at <= now) return { cls: "ready", text: "Ready", rank: 1, at: 0, title: "cooldown over" };
        return { cls: "cool", text: fmtDuration(at - now), rank: 2, at, title: "time until next airstrike can pass" };
    }

    function airColumn(title, cls, ids) {
        const rows = ids
            .map(id => ({ id, d: describeAir(airResults[id]) }))
            .sort((a, b) => a.d.rank - b.d.rank || a.d.at - b.d.at);
        let html = `<div class="cw-acol"><div class="cw-atitle ${cls}">${title}</div>`;
        for (const r of rows) {
            html += `<div class="cw-arow" title="${escapeHTML(r.d.title)}">` +
                `<span class="cw-aname">${escapeHTML(getCountryName(r.id))}</span>` +
                `<span class="cw-a ${r.d.cls}">${escapeHTML(r.d.text)}</span></div>`;
        }
        return html + "</div>";
    }

    function renderAir() {
        const el = document.getElementById("cw-air-content");
        if (!el) return;
        el.innerHTML =
            '<div class="cw-acols">' +
            airColumn("🛡️ Allies", "cw-side1", airIds(1)) +
            airColumn("⚔️ Enemies", "cw-side2", airIds(2)) +
            "</div>" +
            '<div class="cw-alegend"><span class="cw-a vote">Vote</span> = vote in progress (time left) · ' +
            '<span class="cw-a ready">Ready</span> = can pass now · otherwise time until available</div>';

        const updated = Number(safeGet(AIR_STORE_UPDATED, 0)) || 0;
        if (!airBusy) {
            setAirStatus(
                (updated ? "Updated " + fmtDuration(Date.now() - updated) + " ago" : "Not loaded - tap 🔄") +
                " • eRep day " + currentErepDay()
            );
        }
    }

    function setAirStatus(text) {
        const s = document.getElementById("cw-air-status");
        if (s) s.textContent = text;
    }

    async function refreshAirstrikes() {
        if (airBusy) return;
        airBusy = true;
        const all = [...airIds(1), ...airIds(2)];
        for (let i = 0; i < all.length; i++) {
            const id = all[i];
            setAirStatus(`Scanning ${i + 1}/${all.length}: ${getCountryName(id)}...`);
            try {
                airResults[id] = await scanCountry(AIR_SLUGS[id]);
            } catch (e) {
                airResults[id] = { error: String((e && e.message) || e) };
            }
            safeSet(AIR_STORE_RESULTS, JSON.stringify(airResults));
            renderAir();
            await sleep(AIR_DELAY_MS + Math.random() * 500);
        }
        safeSet(AIR_STORE_UPDATED, Date.now());
        airBusy = false;
        renderAir();
    }

    // Airstrike data is only fetched when you tap the refresh button.
    // This tick just re-renders so countdowns and the "updated X ago" label stay current.
    function airTick() {
        renderAir();
    }

    /******************************************************************
     * UI
     ******************************************************************/
    let activeTab = "wars";

    function createOverlayUI() {
        if (document.getElementById("coalition-wars-widget")) return;

        const overlay = document.createElement("div");
        overlay.id = "coalition-wars-widget";
        overlay.innerHTML = `
            <div id="cw-header">
                <span>⚔️ Coalition <span id="cw-version">v4.1</span></span>
                <span>
                    <span id="cw-refresh" title="Refresh this tab">🔄</span>
                    <span id="cw-collapse" title="Collapse / expand">▾</span>
                </span>
            </div>
            <div id="cw-tabs">
                <button class="cw-tab" data-tab="wars">⚔️ Wars</button>
                <button class="cw-tab" data-tab="air">✈️ Airstrikes</button>
            </div>
            <div id="cw-panel-wars" class="cw-panel">
                <div id="cw-status">Starting...</div>
                <div id="cw-content">Scanning active battlefields...</div>
            </div>
            <div id="cw-panel-air" class="cw-panel">
                <div id="cw-air-status">Loading...</div>
                <div id="cw-air-content"></div>
            </div>
        `;

        const style = document.createElement("style");
        style.textContent = `
            #coalition-wars-widget {
                position: fixed !important; top: 100px !important; right: 15px !important;
                width: 330px !important; max-height: 600px !important;
                background: #191e24 !important; color: #e1e6ed !important;
                border: 2px solid #3b4252 !important; border-radius: 6px !important;
                box-shadow: 0 6px 16px rgba(0,0,0,0.6) !important;
                z-index: 9999999 !important; font-family: Arial, sans-serif !important;
                font-size: 11px !important; display: flex !important; flex-direction: column !important;
                box-sizing: border-box !important;
            }
            #coalition-wars-widget.cw-docked {
                position: relative !important; top: auto !important; right: auto !important;
                width: auto !important; max-height: none !important;
                margin: 6px !important; z-index: 1 !important; font-size: 13px !important;
            }
            #cw-header {
                background: #2e3440 !important; padding: 8px 10px !important; font-weight: bold !important;
                font-size: 12px !important; display: flex !important; justify-content: space-between !important;
                align-items: center !important; border-bottom: 1px solid #4c566a !important;
            }
            .cw-docked #cw-header { font-size: 14px !important; padding: 10px !important; }
            #cw-version { color: #81a1c1 !important; font-size: 9px !important; font-weight: normal !important; }
            #cw-refresh, #cw-collapse {
                cursor: pointer !important; font-size: 15px !important; padding: 2px 8px !important;
                user-select: none !important; -webkit-user-select: none !important;
            }
            .cw-docked #cw-refresh, .cw-docked #cw-collapse { font-size: 19px !important; padding: 4px 12px !important; }
            #cw-refresh:hover, #cw-collapse:hover { opacity: 0.8 !important; }
            #cw-tabs { display: flex !important; border-bottom: 1px solid #3b4252 !important; }
            .cw-tab {
                flex: 1 !important; background: #232830 !important; color: #81a1c1 !important;
                border: 0 !important; border-bottom: 2px solid transparent !important;
                padding: 6px 4px !important; font-size: 11px !important; font-weight: bold !important;
                cursor: pointer !important; border-radius: 0 !important;
            }
            .cw-docked .cw-tab { font-size: 14px !important; padding: 10px 4px !important; }
            .cw-tab.cw-active { color: #eceff4 !important; background: #2e3440 !important; border-bottom-color: #88c0d0 !important; }
            .cw-panel { display: block !important; }
            .cw-panel.cw-hidden { display: none !important; }
            #coalition-wars-widget.cw-collapsed #cw-tabs,
            #coalition-wars-widget.cw-collapsed .cw-panel { display: none !important; }
            #cw-status, #cw-air-status {
                padding: 4px 8px !important; font-size: 9px !important; color: #81a1c1 !important;
                border-bottom: 1px solid #3b4252 !important;
            }
            .cw-docked #cw-status, .cw-docked #cw-air-status { font-size: 11px !important; padding: 6px 10px !important; }
            #cw-content, #cw-air-content {
                padding: 6px !important; overflow-y: auto !important; max-height: 490px !important;
            }
            .cw-docked #cw-content, .cw-docked #cw-air-content { max-height: 65vh !important; }
            .cw-section-title {
                font-weight: bold !important; font-size: 11px !important; text-transform: uppercase !important;
                color: #d8dee9 !important; padding: 5px 2px !important; margin-top: 4px !important;
                border-bottom: 1px solid #3b4252 !important;
            }
            .cw-war-card {
                background: #232830 !important; margin: 4px 0 !important; padding: 7px 8px !important;
                border-radius: 4px !important; border-left: 4px solid #d08770 !important;
            }
            .cw-war-card.rw { border-left-color: #ebcb8b !important; }
            .cw-war-title {
                font-weight: bold !important; color: #88c0d0 !important; margin-bottom: 4px !important;
                display: block !important; text-decoration: none !important;
            }
            .cw-war-title:hover { text-decoration: underline !important; }
            .cw-matchup {
                display: flex !important; justify-content: space-between !important;
                align-items: center !important; gap: 5px !important; color: #d8dee9 !important;
            }
            .cw-side1 { color: #88c0d0 !important; }
            .cw-side2 { color: #bf616a !important; }
            .cw-vs { color: #81a1c1 !important; font-size: 10px !important; }
            .cw-score {
                background: #2e3440 !important; color: #eceff4 !important;
                font-weight: bold !important; padding: 1px 5px !important;
                border-radius: 3px !important; font-size: 10px !important;
            }
            .cw-empty { color: #4c566a !important; font-style: italic !important; font-size: 10px !important; padding: 5px 2px !important; }
            .cw-error { color: #bf616a !important; padding: 5px !important; }
            .cw-debug { color: #d8dee9 !important; font-size: 9px !important; padding: 5px !important; }

            .cw-acols { display: grid !important; grid-template-columns: 1fr 1fr !important; gap: 8px !important; }
            .cw-atitle {
                font-weight: bold !important; font-size: 11px !important; padding: 3px 2px !important;
                border-bottom: 1px solid #3b4252 !important; margin-bottom: 2px !important;
            }
            .cw-arow {
                display: flex !important; justify-content: space-between !important; gap: 4px !important;
                padding: 2px 2px !important; border-bottom: 1px solid #232830 !important;
            }
            .cw-aname { min-width: 0 !important; overflow: hidden !important; text-overflow: ellipsis !important; white-space: nowrap !important; }
            .cw-a { white-space: nowrap !important; font-weight: bold !important; }
            .cw-a.ready { color: #a3be8c !important; }
            .cw-a.cool { color: #d08770 !important; }
            .cw-a.vote { color: #ebcb8b !important; }
            .cw-a.unk { color: #6b7385 !important; }
            .cw-alegend { color: #6b7385 !important; font-size: 9px !important; padding: 6px 2px 0 !important; }
            .cw-docked .cw-arow { padding: 5px 2px !important; }
            .cw-docked .cw-alegend { font-size: 11px !important; }
            .cw-docked .cw-score { font-size: 12px !important; }
        `;
        document.head.appendChild(style);
        document.body.appendChild(overlay);

        document.getElementById("cw-refresh").addEventListener("click", () => {
            if (activeTab === "air") refreshAirstrikes();
            else fetchActiveWars();
        });

        document.getElementById("cw-collapse").addEventListener("click", () => {
            const collapsed = overlay.classList.toggle("cw-collapsed");
            safeSet("cw-collapsed", collapsed ? "1" : "0");
        });

        overlay.querySelectorAll(".cw-tab").forEach(btn => {
            btn.addEventListener("click", () => setTab(btn.getAttribute("data-tab")));
        });

        if (safeGet("cw-collapsed", "0") === "1") overlay.classList.add("cw-collapsed");
        setTab(safeGet("cw-active-tab", "wars"));
        setupPlacement(overlay);
        setupDrag(overlay);
    }

    function setTab(tab) {
        activeTab = tab === "air" ? "air" : "wars";
        safeSet("cw-active-tab", activeTab);
        document.querySelectorAll("#coalition-wars-widget .cw-tab").forEach(btn => {
            btn.classList.toggle("cw-active", btn.getAttribute("data-tab") === activeTab);
        });
        const wars = document.getElementById("cw-panel-wars");
        const air = document.getElementById("cw-panel-air");
        if (wars) wars.classList.toggle("cw-hidden", activeTab !== "wars");
        if (air) air.classList.toggle("cw-hidden", activeTab !== "air");
        if (activeTab === "air") renderAir();
    }

    /*
     * PLACEMENT
     * Wide screens: floating box fixed to the top-right.
     * Narrow screens (phones): docked at the top of the page content, pushing
     * existing elements down instead of covering them.
     */
    function setupPlacement(widget) {
        const mq = window.matchMedia(MOBILE_QUERY);

        function place() {
            if (mq.matches) {
                widget.classList.add("cw-docked");
                const host = document.getElementById("content");
                if (host) {
                    if (host.firstChild !== widget) host.insertBefore(widget, host.firstChild);
                } else if (document.body.firstChild !== widget) {
                    document.body.insertBefore(widget, document.body.firstChild);
                }
            } else {
                widget.classList.remove("cw-docked");
                if (widget.parentNode !== document.body) document.body.appendChild(widget);
            }
        }

        place();
        if (mq.addEventListener) mq.addEventListener("change", place);
        else if (mq.addListener) mq.addListener(place);
    }

    function setupDrag(widget) {
        const header = document.getElementById("cw-header");
        const mq = window.matchMedia(MOBILE_QUERY);
        const KEY = "cw-position";

        function setPos(left, top) {
            left = Math.min(Math.max(0, left), Math.max(0, window.innerWidth - widget.offsetWidth));
            top = Math.min(Math.max(0, top), Math.max(0, window.innerHeight - 40));
            widget.style.setProperty("left", left + "px", "important");
            widget.style.setProperty("top", top + "px", "important");
            widget.style.setProperty("right", "auto", "important");
            return { left, top };
        }

        function clearPos() {
            ["left", "top", "right"].forEach(p => widget.style.removeProperty(p));
        }

        function restore() {
            if (mq.matches) { clearPos(); return; }
            try {
                const p = JSON.parse(safeGet(KEY, "null"));
                if (p) setPos(p.left, p.top);
            } catch (e) { /* ignore */ }
        }

        header.style.cursor = "move";

        header.addEventListener("pointerdown", e => {
            if (mq.matches || e.button !== 0 || e.target.closest("#cw-refresh, #cw-collapse")) return;
            const rect = widget.getBoundingClientRect();
            const dx = e.clientX - rect.left;
            const dy = e.clientY - rect.top;
            let last = null;
            header.setPointerCapture(e.pointerId);

            const move = ev => { last = setPos(ev.clientX - dx, ev.clientY - dy); };
            const up = () => {
                header.removeEventListener("pointermove", move);
                header.removeEventListener("pointerup", up);
                if (last) safeSet(KEY, JSON.stringify(last));
            };
            header.addEventListener("pointermove", move);
            header.addEventListener("pointerup", up);
            e.preventDefault();
        });

        window.addEventListener("resize", restore);
        if (mq.addEventListener) mq.addEventListener("change", restore);
        restore();
    }


    function setStatus(text) {
        const status = document.getElementById("cw-status");
        if (status) status.textContent = text;
    }

    /******************************************************************
     * WARS - REFRESH SCHEDULING & CACHE
     ******************************************************************/
    let refreshTimer = null;

    function getRandomInterval() {
        return Math.floor(Math.random() * (REFRESH_MAX_MS - REFRESH_MIN_MS + 1)) + REFRESH_MIN_MS;
    }

    function scheduleNextRefresh(delay) {
        if (refreshTimer) clearTimeout(refreshTimer);
        const wait = typeof delay === "number" && delay > 0 ? delay : getRandomInterval();
        debug("Next auto-refresh in", Math.round(wait / 1000), "seconds");
        refreshTimer = setTimeout(fetchActiveWars, wait);
    }

    function readCache() {
        if (typeof GM_getValue !== "function") return null;
        try {
            const raw = GM_getValue(CACHE_KEY, null);
            if (!raw) return null;
            const parsed = JSON.parse(raw);
            if (
                !parsed || typeof parsed.timestamp !== "number" ||
                !Array.isArray(parsed.directWars) || !Array.isArray(parsed.resistanceWars)
            ) return null;
            return parsed;
        } catch (error) {
            debug("Failed to read/parse cache:", error);
            return null;
        }
    }

    function writeCache(directWars, resistanceWars, battlesChecked) {
        if (typeof GM_setValue !== "function") return;
        try {
            GM_setValue(CACHE_KEY, JSON.stringify({
                timestamp: Date.now(), directWars, resistanceWars, battlesChecked
            }));
        } catch (error) {
            debug("Failed to write cache:", error);
        }
    }

    function loadInitial() {
        const cached = readCache();
        const now = Date.now();
        if (cached && (now - cached.timestamp) < REFRESH_MIN_MS) {
            const ageSeconds = Math.round((now - cached.timestamp) / 1000);
            debug("Using cached campaign data,", ageSeconds, "seconds old");
            setStatus(`Loaded from cache (${ageSeconds}s old)`);
            renderWars(cached.directWars, cached.resistanceWars);
            scheduleNextRefresh(Math.max(getRandomInterval() - (now - cached.timestamp), 5000));
            return;
        }
        fetchActiveWars();
    }

    /******************************************************************
     * WARS - FETCH ACTIVE CAMPAIGNS
     ******************************************************************/
    function fetchActiveWars() {
        if (refreshTimer) {
            clearTimeout(refreshTimer);
            refreshTimer = null;
        }

        const contentDiv = document.getElementById("cw-content");
        if (contentDiv) {
            contentDiv.innerHTML = '<span style="color:#d8dee9;">Filtering active fronts...</span>';
        }
        setStatus("Contacting eRepublik...");
        debug("Requesting active campaigns...");

        GM_xmlhttpRequest({
            method: "GET",
            url: "https://www.erepublik.com/en/military/campaignsJson/list",
            headers: { "X-Requested-With": "XMLHttpRequest", "Accept": "application/json" },

            onload: function (response) {
                debug("HTTP status:", response.status);
                if (response.status < 200 || response.status >= 300) {
                    showError(`eRepublik returned HTTP ${response.status}.`);
                    scheduleNextRefresh();
                    return;
                }

                let data;
                try {
                    data = JSON.parse(response.responseText);
                } catch (error) {
                    debug("JSON parse error:", error);
                    showError("eRepublik returned invalid JSON.");
                    scheduleNextRefresh();
                    return;
                }

                if (DEBUG) {
                    console.group("[Coalition Wars] Raw campaign response");
                    console.log(data);
                    console.groupEnd();
                }

                const battlesList = getBattleArray(data);
                debug("Campaigns/battles received:", battlesList.length);

                if (DEBUG_BATTLE_ID) {
                    const target = battlesList.find(b => extractBattleId(b) === String(DEBUG_BATTLE_ID));
                    if (target) {
                        console.group("[Coalition Wars] DEBUG_BATTLE_ID " + DEBUG_BATTLE_ID + " - RAW OBJECT");
                        console.log(JSON.parse(JSON.stringify(target)));
                        console.log("[Coalition Wars] RAW OBJECT (full JSON text, copy this):\n" + JSON.stringify(target, null, 2));
                        console.groupEnd();
                        console.group("[Coalition Wars] DEBUG_BATTLE_ID " + DEBUG_BATTLE_ID + " - WHAT OUR PARSER SEES");
                        console.log("isResistanceWar():", isResistanceWar(target));
                        console.log("extractAttacker():", extractAttacker(target));
                        console.log("extractDefender():", extractDefender(target));
                        console.log("extractResistanceDefender():", extractResistanceDefender(target));
                        console.groupEnd();
                    } else {
                        console.warn(
                            "[Coalition Wars] DEBUG_BATTLE_ID " + DEBUG_BATTLE_ID +
                            " was NOT found in the parsed battle list. Raw top-level response keys:",
                            data && typeof data === "object" ? Object.keys(data) : typeof data
                        );
                        console.log("[Coalition Wars] Full raw response:", data);
                    }
                }

                const directWars = uniqueByBattleId(parseDirectWars(battlesList));
                const resistanceWars = uniqueByBattleId(parseResistanceWars(battlesList));

                debug("Matching direct wars:", directWars);
                debug("Matching resistance wars:", resistanceWars);

                setStatus(
                    `${battlesList.length} active campaigns checked • ` +
                    `${directWars.length + resistanceWars.length} matches`
                );

                renderWars(directWars, resistanceWars);
                writeCache(directWars, resistanceWars, battlesList.length);
                scheduleNextRefresh();
            },

            onerror: function (error) {
                debug("Network error:", error);
                showError("Network request to eRepublik failed.");
                scheduleNextRefresh();
            },

            ontimeout: function () {
                showError("eRepublik request timed out.");
                scheduleNextRefresh();
            }
        });
    }

    function showError(message) {
        setStatus("ERROR");
        const contentDiv = document.getElementById("cw-content");
        if (!contentDiv) return;
        contentDiv.innerHTML = `<div class="cw-error">${escapeHTML(message)}</div>`;
    }

    /******************************************************************
     * WARS - RENDER
     ******************************************************************/
    function renderWars(directWars, resistanceWars) {
        const contentDiv = document.getElementById("cw-content");
        if (!contentDiv) return;

        const score = v => (v === null || v === undefined) ? "–" : v;

        let html = '<div class="cw-section-title">⚔️ Direct Coalition Wars</div>';

        if (directWars.length === 0) {
            html += '<div class="cw-empty">No active Side 1 vs Side 2 wars.</div>';
        } else {
            for (const war of directWars) {
                const attackerClass = war.attackerSide === 1 ? "cw-side1" : "cw-side2";
                const defenderClass = war.defenderSide === 1 ? "cw-side1" : "cw-side2";
                html += `
                    <div class="cw-war-card">
                        <a class="cw-war-title"
                           href="/en/military/battlefield/${encodeURIComponent(war.id)}"
                           target="_blank" rel="noopener noreferrer">${escapeHTML(war.region)}</a>
                        <div class="cw-matchup">
                            <span class="${attackerClass}">⚔️ <b>${escapeHTML(war.invader)}</b> <span class="cw-score">${score(war.invPoints)}</span></span>
                            <span class="cw-vs">vs</span>
                            <span class="${defenderClass}"><span class="cw-score">${score(war.defPoints)}</span> <b>${escapeHTML(war.defender)}</b> 🛡️</span>
                        </div>
                    </div>`;
            }
        }

        html += '<div class="cw-section-title">✊ Resistance Wars</div>';

        if (resistanceWars.length === 0) {
            html += '<div class="cw-empty">No active RWs involving Side 1 or Side 2 defenders.</div>';
        } else {
            for (const war of resistanceWars) {
                const resistanceClass = war.resistanceSide === 1 ? "cw-side1" : war.resistanceSide === 2 ? "cw-side2" : "";
                const occupierClass = war.occupierSide === 1 ? "cw-side1" : war.occupierSide === 2 ? "cw-side2" : "";
                html += `
                    <div class="cw-war-card rw">
                        <a class="cw-war-title"
                           href="/en/military/battlefield/${encodeURIComponent(war.id)}"
                           target="_blank" rel="noopener noreferrer">${escapeHTML(war.region)}</a>
                        <div class="cw-matchup">
                            <span class="${resistanceClass}">✊ <b>${escapeHTML(war.resistance)}</b> <span class="cw-score">${score(war.resistancePoints)}</span></span>
                            <span class="cw-vs">vs</span>
                            <span class="${occupierClass}"><span class="cw-score">${score(war.occupierPoints)}</span> <b>${escapeHTML(war.occupier)}</b> 🛡️</span>
                        </div>
                    </div>`;
            }
        }

        if (DEBUG) {
            html += `
                <div class="cw-debug">
                    <b>DEBUG</b><br>
                    Side 1 countries: ${SIDE_1_IDS.size}<br>
                    Side 2 countries: ${SIDE_2_IDS.size}<br>
                    Direct matches: ${directWars.length}<br>
                    RW matches: ${resistanceWars.length}
                </div>`;
        }

        contentDiv.innerHTML = html;
    }

    /******************************************************************
     * START
     ******************************************************************/
    createOverlayUI();
    loadInitial();
    renderAir();
    setInterval(airTick, 60000);

})();
