// Ren slot-logik uden I/O. Intervaller er { start, end } i epoch-millisekunder (UTC).
import { DateTime, Duration } from 'luxon';

export function isoMinutes(iso, fallback = 0) {
  if (!iso) return fallback;
  const d = Duration.fromISO(iso);
  return d.isValid ? d.as('minutes') : fallback;
}

export function merge(intervals) {
  const sorted = intervals.filter((i) => i.end > i.start).sort((a, b) => a.start - b.start);
  const out = [];
  for (const i of sorted) {
    const last = out[out.length - 1];
    if (last && i.start <= last.end) last.end = Math.max(last.end, i.end);
    else out.push({ start: i.start, end: i.end });
  }
  return out;
}

export function intersect(a, b) {
  const A = merge(a);
  const B = merge(b);
  const out = [];
  let i = 0;
  let j = 0;
  while (i < A.length && j < B.length) {
    const start = Math.max(A[i].start, B[j].start);
    const end = Math.min(A[i].end, B[j].end);
    if (end > start) out.push({ start, end });
    if (A[i].end < B[j].end) i++;
    else j++;
  }
  return out;
}

function wallTime(day, hhmmss) {
  const [h, m] = hhmmss.split(':').map(Number);
  return day.set({ hour: h, minute: m, second: 0, millisecond: 0 });
}

// Bookings' businessHours: [{ day: 'monday', timeSlots: [{ startTime: '08:00:00.0000000', endTime: '16:00:00.0000000' }] }]
export function businessHourWindows(businessHours, fromMs, toMs, zone) {
  if (!businessHours?.length) return null; // null = ingen begrænsning
  const byDay = new Map(businessHours.map((d) => [d.day.toLowerCase(), d.timeSlots || []]));
  const out = [];
  let day = DateTime.fromMillis(fromMs, { zone }).startOf('day');
  const last = DateTime.fromMillis(toMs, { zone });
  while (day <= last) {
    const name = day.setLocale('en').toFormat('cccc').toLowerCase();
    for (const slot of byDay.get(name) || []) {
      out.push({
        start: wallTime(day, slot.startTime).toMillis(),
        end: wallTime(day, slot.endTime).toMillis(),
      });
    }
    day = day.plus({ days: 1 });
  }
  return merge(out);
}

function overlaps(busy, start, end) {
  return busy.some((b) => b.start < end && b.end > start);
}

/**
 * Finder ledige starttider.
 * windows: hvor der må ligge møder (Bookings-ledighed ∩ åbningstider)
 * busy:    optaget-tid fra alle kalendere
 */
export function computeSlots({
  windows,
  busy,
  durationMin,
  intervalMin,
  preBufferMin = 0,
  postBufferMin = 0,
  minLeadMin = 0,
  maxAdvanceMin = Infinity,
  now,
  fromMs,
  toMs,
  zone,
}) {
  const W = merge(windows);
  const B = merge(busy);
  const earliest = now + minLeadMin * 60_000;
  const latest = now + maxAdvanceMin * 60_000;
  const step = Math.max(5, intervalMin || durationMin);
  const slots = [];

  let day = DateTime.fromMillis(fromMs, { zone }).startOf('day');
  const lastDay = DateTime.fromMillis(toMs, { zone });
  while (day <= lastDay) {
    for (let m = 0; m < 24 * 60; m += step) {
      const s = day.set({ hour: Math.floor(m / 60), minute: m % 60 });
      if (!s.hasSame(day, 'day')) continue; // sommertidsspring
      const start = s.toMillis();
      const end = start + durationMin * 60_000;
      if (start < fromMs || start >= toMs) continue;
      if (start < earliest || start > latest) continue;
      if (!W.some((w) => w.start <= start && w.end >= end)) continue;
      if (overlaps(B, start - preBufferMin * 60_000, end + postBufferMin * 60_000)) continue;
      if (slots.length && slots[slots.length - 1] === start) continue;
      slots.push(start);
    }
    day = day.plus({ days: 1 });
  }
  return slots;
}
