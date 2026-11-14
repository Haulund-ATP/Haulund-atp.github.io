import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DateTime } from 'luxon';
import ical from 'node-ical';
import { computeSlots, businessHourWindows, intersect, merge, isoMinutes } from '../src/slots.js';
import { busyFromIcs } from '../src/ics.js';

const Z = 'Europe/Copenhagen';
const t = (s) => DateTime.fromISO(s, { zone: Z }).toMillis();
const fmt = (ms) => DateTime.fromMillis(ms, { zone: Z }).toFormat('MM-dd HH:mm');

const base = {
  durationMin: 30,
  intervalMin: 30,
  now: t('2026-11-01T00:00'),
  zone: Z,
};

test('isoMinutes', () => {
  assert.equal(isoMinutes('PT30M'), 30);
  assert.equal(isoMinutes('P1D'), 1440);
  assert.equal(isoMinutes(null, 15), 15);
});

test('merge og intersect', () => {
  assert.deepEqual(merge([{ start: 5, end: 8 }, { start: 1, end: 3 }, { start: 2, end: 6 }]), [{ start: 1, end: 8 }]);
  assert.deepEqual(intersect([{ start: 0, end: 10 }], [{ start: 2, end: 4 }, { start: 8, end: 12 }]), [
    { start: 2, end: 4 },
    { start: 8, end: 10 },
  ]);
});

test('slots i et vindue, minus optaget med buffer', () => {
  const slots = computeSlots({
    ...base,
    windows: [{ start: t('2026-11-16T09:00'), end: t('2026-11-16T12:00') }],
    busy: [{ start: t('2026-11-16T10:00'), end: t('2026-11-16T10:30') }],
    postBufferMin: 15,
    fromMs: t('2026-11-16T00:00'),
    toMs: t('2026-11-17T00:00'),
  });
  // 09:30 slutter 10:00 + 15 min buffer → rammer 10:00-mødet
  assert.deepEqual(slots.map(fmt), ['11-16 09:00', '11-16 10:30', '11-16 11:00', '11-16 11:30']);
});

test('minimum lead time og max advance', () => {
  const slots = computeSlots({
    ...base,
    now: t('2026-11-16T09:10'),
    minLeadMin: 60,
    maxAdvanceMin: 150,
    windows: [{ start: t('2026-11-16T09:00'), end: t('2026-11-16T12:00') }],
    busy: [],
    fromMs: t('2026-11-16T00:00'),
    toMs: t('2026-11-17T00:00'),
  });
  assert.deepEqual(slots.map(fmt), ['11-16 10:30', '11-16 11:00', '11-16 11:30']);
});

test('åbningstider følger lokal tid over sommertidsskift', () => {
  const hours = [{ day: 'sunday', timeSlots: [{ startTime: '09:00:00.0000000', endTime: '10:00:00.0000000' }] }];
  const w = businessHourWindows(hours, t('2026-10-24T00:00'), t('2026-10-26T00:00'), Z);
  // 25. okt 2026 er dagen hvor uret stilles tilbage
  assert.equal(w.length, 1);
  assert.equal(DateTime.fromMillis(w[0].start, { zone: Z }).toFormat('yyyy-MM-dd HH:mm'), '2026-10-25 09:00');
});

test('ICS: gentagelser, aflyste og fri-tid', async () => {
  const ics = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:weekly
DTSTART;TZID=Europe/Copenhagen:20261102T100000
DTEND;TZID=Europe/Copenhagen:20261102T110000
RRULE:FREQ=WEEKLY;COUNT=4
EXDATE;TZID=Europe/Copenhagen:20261109T100000
SUMMARY:Ugentligt
END:VEVENT
BEGIN:VEVENT
UID:free
DTSTART;TZID=Europe/Copenhagen:20261103T120000
DTEND;TZID=Europe/Copenhagen:20261103T130000
X-MICROSOFT-CDO-BUSYSTATUS:FREE
SUMMARY:Fri
END:VEVENT
BEGIN:VEVENT
UID:cancelled
DTSTART;TZID=Europe/Copenhagen:20261104T120000
DTEND;TZID=Europe/Copenhagen:20261104T130000
STATUS:CANCELLED
END:VEVENT
END:VCALENDAR`;
  const data = await ical.async.parseICS(ics);
  const busy = busyFromIcs(data, t('2026-11-01T00:00'), t('2026-12-01T00:00'));
  assert.deepEqual(busy.map((b) => fmt(b.start)).sort(), ['11-02 10:00', '11-16 10:00', '11-23 10:00']);
});
