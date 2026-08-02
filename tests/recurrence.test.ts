import { describe, expect, it } from 'vitest';
import { makeAppointment, type CoziAppointment } from '../src/cozi/index.js';
import {
  occurrencesInMonth,
  expandAppointmentForMonth,
  expandAppointmentsForMonth,
} from '../src/tools/recurrence.js';

// Fixtures mirror the REAL Cozi wire shapes captured from 133 live appointments
// (2026-08-02): recurrence lives in itemDetails with a `rules` array; the master
// item's `day`/recurrenceStartDay is the original DTSTART, never the occurrence.

function recurring(
  startDay: string,
  recurrence: Record<string, unknown>,
  recurrenceStartDay = startDay,
): CoziAppointment {
  return {
    ...makeAppointment({ id: 'series1', subject: 'Series', startDay }),
    recurrence,
    recurrenceStartDay,
  };
}

describe('occurrencesInMonth', () => {
  it('expands a weekly "every Monday" series across the queried month', () => {
    // Real shape: {"rules":[{"frequency":"Weekly","interval":1,"byDay":["MO"]}]}
    const appt = recurring('2025-07-28', {
      rules: [{ frequency: 'Weekly', interval: 1, byDay: ['MO'] }],
    });
    expect(occurrencesInMonth(appt, 2026, 8)).toEqual([
      '2026-08-03',
      '2026-08-10',
      '2026-08-17',
      '2026-08-24',
      '2026-08-31',
    ]);
  });

  it('expands weekly weekdays and honours end.untilDay (inclusive)', () => {
    const appt = recurring('2026-08-03', {
      rules: [
        {
          frequency: 'Weekly',
          interval: 1,
          end: { untilDay: '2026-08-14' },
          byDay: ['MO', 'TU', 'WE', 'TH', 'FR'],
        },
      ],
      endDay: '2026-08-14',
    });
    expect(occurrencesInMonth(appt, 2026, 8)).toEqual([
      '2026-08-03',
      '2026-08-04',
      '2026-08-05',
      '2026-08-06',
      '2026-08-07',
      '2026-08-10',
      '2026-08-11',
      '2026-08-12',
      '2026-08-13',
      '2026-08-14',
    ]);
  });

  it('does not emit occurrences before the anchor / recurrenceStartDay', () => {
    const appt = recurring('2026-08-03', {
      rules: [{ frequency: 'Weekly', interval: 1, byDay: ['MO', 'TU', 'WE', 'TH', 'FR'] }],
    });
    // July is entirely before the 2026-08-03 anchor.
    expect(occurrencesInMonth(appt, 2026, 7)).toEqual([]);
  });

  it('honours an interval > 1 (bi-weekly)', () => {
    // Anchor Monday 2026-08-03; every 2nd week -> 08-03, 08-17, 08-31.
    const appt = recurring('2026-08-03', {
      rules: [{ frequency: 'Weekly', interval: 2, byDay: ['MO'] }],
    });
    expect(occurrencesInMonth(appt, 2026, 8)).toEqual(['2026-08-03', '2026-08-17', '2026-08-31']);
  });

  it('expands a yearly fixed-date holiday (Christmas: byMonthDay/byMonth)', () => {
    const appt = recurring('2023-12-25', {
      rules: [{ frequency: 'Yearly', interval: 1, byMonthDay: [25], byMonth: [12] }],
    });
    expect(occurrencesInMonth(appt, 2026, 12)).toEqual(['2026-12-25']);
    expect(occurrencesInMonth(appt, 2026, 11)).toEqual([]);
  });

  it('expands a yearly nth-weekday holiday (MLK: 3rd Monday of January)', () => {
    const appt = recurring('2025-01-20', {
      rules: [{ frequency: 'Yearly', interval: 1, byDay: ['3MO'], byMonth: [1] }],
    });
    expect(occurrencesInMonth(appt, 2026, 1)).toEqual(['2026-01-19']); // MLK 2026
  });

  it('expands a yearly last-weekday holiday (Memorial Day: last Monday of May)', () => {
    const appt = recurring('2023-05-29', {
      rules: [{ frequency: 'Yearly', interval: 1, byDay: ['-1MO'], byMonth: [5] }],
    });
    expect(occurrencesInMonth(appt, 2026, 5)).toEqual(['2026-05-25']); // Memorial Day 2026
  });

  it('excludes dates listed in exdates', () => {
    const appt = recurring('2026-08-03', {
      rules: [{ frequency: 'Weekly', interval: 1, byDay: ['MO'] }],
      exdates: [{ date: '2026-08-17T00:00:00' }],
    });
    expect(occurrencesInMonth(appt, 2026, 8)).toEqual(['2026-08-03', '2026-08-10', '2026-08-24', '2026-08-31']);
  });

  it('supports a daily frequency', () => {
    const appt = recurring('2026-08-28', {
      rules: [{ frequency: 'Daily', interval: 1, end: { untilDay: '2026-08-31' } }],
    });
    expect(occurrencesInMonth(appt, 2026, 8)).toEqual(['2026-08-28', '2026-08-29', '2026-08-30', '2026-08-31']);
  });

  it('supports monthly by day-of-month', () => {
    const appt = recurring('2026-01-15', {
      rules: [{ frequency: 'Monthly', interval: 1, byMonthDay: [15] }],
    });
    expect(occurrencesInMonth(appt, 2026, 8)).toEqual(['2026-08-15']);
  });

  it('returns null for a non-recurring appointment', () => {
    const appt = makeAppointment({ id: 'x', subject: 'One-off', startDay: '2026-08-10' });
    expect(occurrencesInMonth(appt, 2026, 8)).toBeNull();
  });

  it('returns null for an unknown frequency (caller keeps the master as-is)', () => {
    const appt = recurring('2026-08-03', {
      rules: [{ frequency: 'Hourly', interval: 1 }],
    });
    expect(occurrencesInMonth(appt, 2026, 8)).toBeNull();
  });
});

describe('expandAppointmentForMonth', () => {
  it('replaces a recurring master with one appointment per occurrence, day set correctly', () => {
    const appt = recurring('2025-07-28', {
      rules: [{ frequency: 'Weekly', interval: 1, byDay: ['MO'] }],
    });
    const expanded = expandAppointmentForMonth(appt, 2026, 8);
    expect(expanded.map((a) => a.startDay)).toEqual([
      '2026-08-03',
      '2026-08-10',
      '2026-08-17',
      '2026-08-24',
      '2026-08-31',
    ]);
    // Every occurrence keeps the series id and subject.
    expect(expanded.every((a) => a.id === 'series1' && a.subject === 'Series')).toBe(true);
  });

  it('passes a non-recurring appointment through unchanged', () => {
    const appt = makeAppointment({ id: 'x', subject: 'One-off', startDay: '2026-08-10' });
    expect(expandAppointmentForMonth(appt, 2026, 8)).toEqual([appt]);
  });

  it('keeps the master as-is when the recurrence is not understood', () => {
    const appt = recurring('2026-08-03', { rules: [{ frequency: 'Hourly' }] });
    expect(expandAppointmentForMonth(appt, 2026, 8)).toEqual([appt]);
  });
});

describe('expandAppointmentsForMonth', () => {
  it('expands recurring masters, keeps one-offs, sorts by day, de-dupes (id,day)', () => {
    const weekly = recurring('2025-07-28', {
      rules: [{ frequency: 'Weekly', interval: 1, byDay: ['MO'] }],
    });
    const oneOff = makeAppointment({ id: 'z', subject: 'Dentist', startDay: '2026-08-12' });
    const result = expandAppointmentsForMonth([weekly, oneOff, weekly], 2026, 8);
    // weekly (5 Mondays) + one-off = 6 entries; the duplicated weekly master does
    // not double the occurrences.
    expect(result.map((a) => a.startDay)).toEqual([
      '2026-08-03',
      '2026-08-10',
      '2026-08-12',
      '2026-08-17',
      '2026-08-24',
      '2026-08-31',
    ]);
  });
});
