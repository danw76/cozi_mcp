import type { CoziAppointment } from '../cozi/index.js';

/**
 * Recurring-appointment expansion for the calendar read path.
 *
 * Cozi's `/calendar/{year}/{month}` endpoint returns a recurring series as a
 * SINGLE master item whose `day` is the original start date (the DTSTART),
 * never the occurrence within the queried month. Verified against 133 live
 * appointments on 2026-07-24 / 2026-08-02: e.g. a weekly meeting started
 * 2025-07-28 still arrives with `day: "2025-07-28"` when you query August 2026,
 * and Christmas arrives anchored at `2023-12-25`. Emitting the master verbatim
 * therefore drops (or misplaces) every recurring event in any month other than
 * its first — holidays, birthdays, and weekly meetings all vanish.
 *
 * This module expands a master into the concrete occurrence dates that fall
 * inside the queried month. It is applied ONLY in the read tool
 * (getCalendarHandler); the write paths (update/delete) still read the raw
 * master via CoziClient.getCalendar so they continue to edit the series as a
 * whole.
 *
 * The recurrence wire shape (real examples, personal text redacted):
 *   Weekly weekdays:  {"rules":[{"frequency":"Weekly","interval":1,
 *                       "end":{"untilDay":"2026-08-14"},
 *                       "byDay":["MO","TU","WE","TH","FR"]}],"endDay":"2026-08-14"}
 *   Every Monday:     {"rules":[{"frequency":"Weekly","interval":1,"byDay":["MO"]}]}
 *   Christmas:        {"rules":[{"frequency":"Yearly","interval":1,
 *                       "byMonthDay":[25],"byMonth":[12]}]}
 *   MLK (3rd Mon Jan):{"rules":[{"frequency":"Yearly","interval":1,
 *                       "byDay":["3MO"],"byMonth":[1]}]}
 *   Memorial (last Mon May): byDay ["-1MO"], byMonth [5]
 *   Optional: exdates:[{date:"2026-05-22T10:00:00"}] — excluded occurrences.
 */

const WEEKDAY_INDEX: Record<string, number> = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
const KNOWN_FREQUENCIES = new Set(['Daily', 'Weekly', 'Monthly', 'Yearly']);

interface RecurrenceRule {
  frequency?: unknown;
  interval?: unknown;
  byDay?: unknown;
  byMonth?: unknown;
  byMonthDay?: unknown;
  end?: { untilDay?: unknown; count?: unknown } | null;
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function toUtcDate(dateStr: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(dateStr);
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return Number.isNaN(d.getTime()) ? null : d;
}

function ymd(d: Date): string {
  const y = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, '0');
  const da = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${mo}-${da}`;
}

const epochDay = (d: Date): number => Math.floor(d.getTime() / 86_400_000);
const daysInMonth = (year: number, month: number): number => new Date(Date.UTC(year, month, 0)).getUTCDate();
const monthDiff = (a: Date, b: Date): number =>
  (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth());

/** Monday-based start of the week containing d (WKST=MO, the RRULE default). */
function mondayEpochDay(d: Date): number {
  const dow = d.getUTCDay(); // 0=Sun..6=Sat
  const backToMonday = (dow + 6) % 7; // Mon->0, Sun->6
  return epochDay(d) - backToMonday;
}

/** Day-of-month of the nth weekday (n<0 counts from the end), or null if none. */
function nthWeekdayOfMonth(year: number, month: number, weekday: number, n: number): number | null {
  const dim = daysInMonth(year, month);
  if (n > 0) {
    const firstDow = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
    const day = 1 + ((weekday - firstDow + 7) % 7) + (n - 1) * 7;
    return day <= dim ? day : null;
  }
  if (n < 0) {
    const lastDow = new Date(Date.UTC(year, month - 1, dim)).getUTCDay();
    const day = dim - ((lastDow - weekday + 7) % 7) + (n + 1) * 7;
    return day >= 1 ? day : null;
  }
  return null;
}

/** Parse a byDay token: plain "MO" or ordinal "3MO" / "-1MO". */
function parseByDay(token: unknown): { weekday: number; ordinal: number | null } | null {
  if (typeof token !== 'string') return null;
  const m = /^(-?\d+)?(SU|MO|TU|WE|TH|FR|SA)$/.exec(token.trim());
  if (!m) return null;
  return { weekday: WEEKDAY_INDEX[m[2]!]!, ordinal: m[1] ? Number(m[1]) : null };
}

function asIntArray(v: unknown): number[] {
  return Array.isArray(v) ? v.filter((n): n is number => typeof n === 'number') : [];
}

/** Does date D match the day-of-month constraints of a monthly/yearly rule? */
function matchesDayOfMonth(d: Date, anchor: Date, rule: RecurrenceRule): boolean {
  const byMonthDay = asIntArray(rule.byMonthDay);
  if (byMonthDay.length) {
    const dim = daysInMonth(d.getUTCFullYear(), d.getUTCMonth() + 1);
    return byMonthDay.some((n) => (n > 0 ? d.getUTCDate() === n : d.getUTCDate() === dim + n + 1));
  }
  if (Array.isArray(rule.byDay) && rule.byDay.length) {
    return rule.byDay.some((token) => {
      const parsed = parseByDay(token);
      if (!parsed || parsed.ordinal == null) return false;
      if (d.getUTCDay() !== parsed.weekday) return false;
      const target = nthWeekdayOfMonth(d.getUTCFullYear(), d.getUTCMonth() + 1, parsed.weekday, parsed.ordinal);
      return target === d.getUTCDate();
    });
  }
  // No explicit day constraint: same day-of-month as the anchor.
  return d.getUTCDate() === anchor.getUTCDate();
}

function matchesRule(d: Date, anchor: Date, rule: RecurrenceRule): boolean {
  const frequency = String(rule.frequency);
  const interval = typeof rule.interval === 'number' && rule.interval > 0 ? rule.interval : 1;

  switch (frequency) {
    case 'Daily':
      return (epochDay(d) - epochDay(anchor)) % interval === 0;

    case 'Weekly': {
      const days =
        Array.isArray(rule.byDay) && rule.byDay.length
          ? rule.byDay.map(parseByDay).filter((p): p is { weekday: number; ordinal: number | null } => p != null).map((p) => p.weekday)
          : [anchor.getUTCDay()];
      if (!days.includes(d.getUTCDay())) return false;
      if (interval === 1) return true;
      const weeks = (mondayEpochDay(d) - mondayEpochDay(anchor)) / 7;
      return Number.isInteger(weeks) && weeks % interval === 0;
    }

    case 'Monthly':
      if (monthDiff(anchor, d) % interval !== 0) return false;
      return matchesDayOfMonth(d, anchor, rule);

    case 'Yearly': {
      if ((d.getUTCFullYear() - anchor.getUTCFullYear()) % interval !== 0) return false;
      const months = asIntArray(rule.byMonth);
      const monthOk = months.length ? months.includes(d.getUTCMonth() + 1) : d.getUTCMonth() + 1 === anchor.getUTCMonth() + 1;
      if (!monthOk) return false;
      return matchesDayOfMonth(d, anchor, rule);
    }

    default:
      return false;
  }
}

/**
 * The occurrence dates (YYYY-MM-DD) of a recurring appointment that fall within
 * the given month. Returns:
 *   - a (possibly empty) sorted array when the recurrence was understood, or
 *   - null when the appointment is not recurring, or its rule uses a frequency
 *     this expander does not understand — the caller then keeps the master item
 *     verbatim (preserving the pre-existing behavior rather than dropping it).
 */
export function occurrencesInMonth(appt: CoziAppointment, year: number, month: number): string[] | null {
  const rec = appt.recurrence;
  if (!isObj(rec)) return null;
  const rules = Array.isArray(rec.rules) ? (rec.rules as RecurrenceRule[]) : null;
  if (!rules || rules.length === 0) return null;

  const anchor = toUtcDate(appt.recurrenceStartDay ?? appt.startDay);
  if (!anchor) return null;

  const seriesEndDay = typeof rec.endDay === 'string' ? toUtcDate(rec.endDay) : null;
  const exdates = new Set(
    (Array.isArray(rec.exdates) ? rec.exdates : [])
      .map((e) => (isObj(e) && typeof e.date === 'string' ? e.date.slice(0, 10) : null))
      .filter((d): d is string => d != null),
  );

  const dim = daysInMonth(year, month);
  const result = new Set<string>();
  let understoodAny = false;

  for (const rule of rules) {
    if (!isObj(rule) || !KNOWN_FREQUENCIES.has(String(rule.frequency))) continue;
    understoodAny = true;

    // `until` is the last occurrence day (inclusive), from the rule's own
    // end.untilDay or the series-level endDay mirror. COUNT-based ends were not
    // present in any observed data; if one appears it is simply not bounded here
    // (over-inclusion after the end, never omission) — see occurrencesInMonth doc.
    const untilStr = isObj(rule.end) && typeof rule.end.untilDay === 'string' ? rule.end.untilDay : null;
    const until = (untilStr ? toUtcDate(untilStr) : null) ?? seriesEndDay;

    for (let day = 1; day <= dim; day++) {
      const d = new Date(Date.UTC(year, month - 1, day));
      if (epochDay(d) < epochDay(anchor)) continue;
      if (until && epochDay(d) > epochDay(until)) continue;
      const ds = ymd(d);
      if (exdates.has(ds)) continue;
      if (matchesRule(d, anchor, rule)) result.add(ds);
    }
  }

  if (!understoodAny) return null;
  return [...result].sort();
}

/**
 * Expand one appointment for a month view. Non-recurring appointments pass
 * through unchanged. A recurring master is replaced by one appointment per
 * occurrence in the month, each carrying the master's fields with `startDay`
 * set to the occurrence date. An unparseable/unknown recurrence falls back to
 * the master as-is.
 */
export function expandAppointmentForMonth(
  appt: CoziAppointment,
  year: number,
  month: number,
): CoziAppointment[] {
  if (!appt.recurrence) return [appt];
  const dates = occurrencesInMonth(appt, year, month);
  if (dates == null) return [appt];
  return dates.map((startDay) => ({ ...appt, startDay }));
}

/**
 * Expand a month's worth of appointments, replacing recurring masters with
 * their in-month occurrences. Results are de-duplicated by (id, day) — a guard
 * against a series appearing more than once in a response — and sorted by day.
 */
export function expandAppointmentsForMonth(
  appts: CoziAppointment[],
  year: number,
  month: number,
): CoziAppointment[] {
  const seen = new Set<string>();
  const out: CoziAppointment[] = [];
  for (const appt of appts) {
    for (const occ of expandAppointmentForMonth(appt, year, month)) {
      const key = `${occ.id ?? ''} ${occ.startDay}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(occ);
    }
  }
  out.sort((a, b) => (a.startDay < b.startDay ? -1 : a.startDay > b.startDay ? 1 : 0));
  return out;
}
