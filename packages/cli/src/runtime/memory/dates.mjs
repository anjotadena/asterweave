// Deterministic date bounds for `memory search --since/--until`.
//
// Accepted: an ISO date ("2026-11-03"), an ISO date-time with an offset or Z ("2026-11-03T10:00:00Z"; without an offset it
// is read in the local time zone), `now`, `today`, `yesterday`, `last <weekday>`, `this week`, `last week`, `this month`,
// `last month`, and `N minutes|hours|days|weeks|months ago`. Everything is resolved against the injected `now` in an explicit
// time zone (default: the machine's), so the same input and clock always give the same instant: tests pass both.
//
// Day-sized phrases cover the whole local day: as `--since` the bound is its first instant, as `--until` its last
// millisecond. "last tuesday" is the most recent Tuesday strictly before today (a week ago when today is a Tuesday).
// "last week" is the previous Monday-to-Sunday week.

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

export const defaultTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

function formatter(timeZone) {
  return new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

/** Civil date-time of an instant in a zone. */
function localParts(date, timeZone) {
  const parts = Object.fromEntries(formatter(timeZone).formatToParts(date).filter((part) => part.type !== "literal").map((part) => [part.type, Number(part.value)]));
  return { y: parts.year, mo: parts.month, d: parts.day, h: parts.hour % 24, mi: parts.minute, s: parts.second };
}

function offsetMs(date, timeZone) {
  const p = localParts(date, timeZone);
  return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - Math.floor(date.getTime() / 1000) * 1000;
}

/** The instant at which the zone's clock reads the given civil time. */
function zonedToUtc({ y, mo, d, h = 0, mi = 0, s = 0, ms = 0 }, timeZone) {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s, ms);
  let result = guess - offsetMs(new Date(guess), timeZone);
  const again = guess - offsetMs(new Date(result), timeZone); // one correction across a daylight-saving change
  if (again !== result) result = again;
  return new Date(result);
}

const civil = (y, mo, d) => new Date(Date.UTC(y, mo - 1, d));
const addCivilDays = (p, days) => {
  const c = civil(p.y, p.mo, p.d + days);
  return { y: c.getUTCFullYear(), mo: c.getUTCMonth() + 1, d: c.getUTCDate() };
};
const dayStart = (p, tz) => zonedToUtc({ y: p.y, mo: p.mo, d: p.d }, tz);

/**
 * @param {string} input
 * @param {{now: string|number|Date, timeZone?: string, edge: 'start'|'end'}} options
 * @returns {{ok: true, iso: string} | {ok: false, message: string}}
 */
export function parseTimeBound(input, { now, timeZone = defaultTimeZone(), edge }) {
  const text = String(input ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  const fail = (message) => ({ ok: false, message });
  if (text === "") return fail("A date is empty.");
  const nowDate = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(nowDate.getTime())) return fail("The current time is not valid.");
  try {
    formatter(timeZone);
  } catch {
    return fail(`Unknown time zone '${String(timeZone).slice(0, 40)}'.`);
  }
  const today = localParts(nowDate, timeZone);
  // A calendar span [first day, last day] -> start of the first day or last millisecond of the last.
  const span = (first, last) => {
    const lastEnd = new Date(dayStart(addCivilDays(last, 1), timeZone).getTime() - 1);
    return { ok: true, iso: (edge === "start" ? dayStart(first, timeZone) : lastEnd).toISOString() };
  };
  const day = (offset) => {
    const p = addCivilDays(today, offset);
    return span(p, p);
  };

  let m;
  if ((m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text))) {
    const p = { y: Number(m[1]), mo: Number(m[2]), d: Number(m[3]) };
    const check = civil(p.y, p.mo, p.d);
    if (check.getUTCMonth() + 1 !== p.mo || check.getUTCDate() !== p.d) return fail(`'${input}' is not a real date.`);
    return span(p, p);
  }
  if ((m = /^(\d{4})-(\d{2})-(\d{2})[t ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(z|[+-]\d{2}:?\d{2})?$/.exec(text))) {
    const parts = { y: Number(m[1]), mo: Number(m[2]), d: Number(m[3]), h: Number(m[4]), mi: Number(m[5]), s: Number(m[6] ?? 0), ms: Number((m[7] ?? "0").padEnd(3, "0")) };
    if (parts.h > 23 || parts.mi > 59 || parts.s > 59) return fail(`'${input}' is not a real time.`);
    let date;
    if (m[8] === undefined) date = zonedToUtc(parts, timeZone);
    else {
      const sign = m[8] === "z" ? 0 : m[8][0] === "-" ? -1 : 1;
      const digits = m[8] === "z" ? "0000" : m[8].slice(1).replace(":", "");
      date = new Date(Date.UTC(parts.y, parts.mo - 1, parts.d, parts.h, parts.mi, parts.s, parts.ms) - sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2))) * 60_000);
    }
    return Number.isNaN(date.getTime()) ? fail(`'${input}' is not a real time.`) : { ok: true, iso: date.toISOString() };
  }
  if (text === "now") return { ok: true, iso: nowDate.toISOString() };
  if (text === "today") return day(0);
  if (text === "yesterday") return day(-1);
  const weekday = (m = /^last ([a-z]+)$/.exec(text)) ? WEEKDAYS.findIndex((name) => name === m[1] || (m[1].length === 3 && name.startsWith(m[1]))) : -1;
  if (weekday >= 0) {
    const target = weekday;
    const todayDow = civil(today.y, today.mo, today.d).getUTCDay();
    return day(-(((todayDow - target + 7) % 7) || 7));
  }
  if (text === "this week" || text === "last week") {
    const todayDow = civil(today.y, today.mo, today.d).getUTCDay();
    const monday = addCivilDays(today, -((todayDow + 6) % 7) - (text === "last week" ? 7 : 0));
    return span(monday, addCivilDays(monday, text === "last week" ? 6 : ((todayDow + 6) % 7)));
  }
  if (text === "this month" || text === "last month") {
    const shift = text === "last month" ? -1 : 0;
    const first = civil(today.y, today.mo + shift, 1);
    const firstP = { y: first.getUTCFullYear(), mo: first.getUTCMonth() + 1, d: 1 };
    const last = text === "last month" ? civil(today.y, today.mo, 0) : civil(today.y, today.mo, today.d);
    return span(firstP, { y: last.getUTCFullYear(), mo: last.getUTCMonth() + 1, d: last.getUTCDate() });
  }
  if ((m = /^(\d{1,4}) (minute|hour|day|week|month)s? ago$/.exec(text))) {
    const n = Number(m[1]);
    if (m[2] === "minute") return { ok: true, iso: new Date(nowDate.getTime() - n * 60_000).toISOString() };
    if (m[2] === "hour") return { ok: true, iso: new Date(nowDate.getTime() - n * 3_600_000).toISOString() };
    if (m[2] === "day") return day(-n);
    if (m[2] === "week") return day(-7 * n);
    const back = civil(today.y, today.mo - n, 1);
    const lastDay = civil(back.getUTCFullYear(), back.getUTCMonth() + 2, 0).getUTCDate();
    const p = { y: back.getUTCFullYear(), mo: back.getUTCMonth() + 1, d: Math.min(today.d, lastDay) };
    return span(p, p);
  }
  return fail(`I could not read '${String(input).slice(0, 40)}' as a date. Use 2026-11-03, 'yesterday', 'last tuesday', '3 days ago', 'last week' or similar.`);
}

/** `2026-11-11 17:30:05 (Asia/Manila)` for display; the stored/exported value stays UTC. */
export function formatLocal(iso, timeZone = defaultTimeZone()) {
  const p = localParts(new Date(iso), timeZone);
  const two = (n) => String(n).padStart(2, "0");
  return `${p.y}-${two(p.mo)}-${two(p.d)} ${two(p.h)}:${two(p.mi)}:${two(p.s)}`;
}
