// Ende-til-ende mod en mocket Microsoft Graph (ingen netværk).
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { DateTime } from 'luxon';

process.env.BOOKING_CLIENT_ID = 'test';
process.env.BOOKING_CLIENT_SECRET = 'test';
process.env.MAILBOX_HAULUND = 'thomas@haulund.test';
process.env.MAILBOX_TIMEWINDER = 'thomas@tw.test';
delete process.env.ATP_ICS_URL;

const { getCatalog, publicCatalog, findSlots, createAppointment, clearCache } = await import('../src/booking.js');

const Z = 'Europe/Copenhagen';
const day = '2026-11-16'; // mandag
const local = (hhmm) => DateTime.fromISO(`${day}T${hhmm}`, { zone: Z });
let posted;

function mockGraph(url, opts) {
  if (url.includes('/oauth2/v2.0/token')) return { access_token: 'tok', expires_in: 3600 };
  const u = decodeURIComponent(url);
  const body = opts.body ? JSON.parse(opts.body) : null;

  if (u.endsWith('/getStaffAvailability')) {
    return {
      value: [
        {
          staffId: 'staff-1',
          availabilityItems: [
            {
              status: 'available',
              startDateTime: { dateTime: `${day}T08:00:00`, timeZone: '(UTC+01:00) Amsterdam, Berlin, Bern, Rome, Stockholm, Vienna' },
              endDateTime: { dateTime: `${day}T12:00:00`, timeZone: '(UTC+01:00) Amsterdam, Berlin, Bern, Rome, Stockholm, Vienna' },
              serviceId: '',
            },
          ],
        },
      ],
    };
  }
  if (u.includes('/calendar/getSchedule')) {
    // TimeWinder-kalenderen er optaget 09:00-10:00 lokal tid (= 08-09 UTC)
    const items = u.includes('thomas@tw.test')
      ? [{ status: 'busy', start: { dateTime: `${day}T08:00:00.0000000`, timeZone: 'UTC' }, end: { dateTime: `${day}T09:00:00.0000000`, timeZone: 'UTC' } }]
      : [];
    return { value: [{ scheduleId: body.schedules[0], scheduleItems: items }] };
  }
  if (u.endsWith('/services')) {
    return {
      value: [
        { id: 'svc-1', displayName: 'Kaffemøde', defaultDuration: 'PT30M', preBuffer: 'PT0S', postBuffer: 'PT0S', isLocationOnline: true, staffMemberIds: [] },
        { id: 'svc-hidden', displayName: 'Skjult', isHiddenFromCustomers: true, defaultDuration: 'PT1H' },
      ],
    };
  }
  if (u.endsWith('/staffMembers')) return { value: [{ id: 'staff-1' }] };
  if (u.endsWith('/appointments') && opts.method === 'POST') {
    posted = { url: u, body };
    return { id: 'appt-1', joinWebUrl: 'https://teams.example/join' };
  }
  if (/bookingBusinesses\/[^/]+$/.test(u)) {
    return {
      id: 'biz',
      businessHours: [{ day: 'monday', timeSlots: [{ startTime: '08:00:00.0000000', endTime: '16:00:00.0000000' }] }],
      schedulingPolicy: { timeSlotInterval: 'PT30M', minimumLeadTime: 'PT0S', maximumAdvance: 'P365D', allowStaffSelection: true },
    };
  }
  throw new Error(`Uventet kald: ${opts.method} ${u}`);
}

globalThis.fetch = async (url, opts = {}) => {
  const data = mockGraph(String(url), opts);
  return { ok: true, status: 200, headers: new Headers(), json: async () => data, text: async () => JSON.stringify(data) };
};

beforeEach(() => {
  clearCache();
  posted = null;
});

test('katalog skjuler skjulte services og prefixer mødetype', async () => {
  const cat = publicCatalog(await getCatalog());
  assert.deepEqual(
    cat.map((c) => c.id),
    ['privat:svc-1', 'timewinder:svc-1'],
  );
  assert.equal(cat[0].durationMinutes, 30);
});

test('ledige tider trækker optaget-tid fra den anden tenant fra', async () => {
  const entry = (await getCatalog()).find((e) => e.id === 'privat:svc-1');
  const { slots } = await findSlots(entry, local('00:00').toMillis(), local('00:00').plus({ days: 1 }).toMillis(), {
    now: local('00:00').minus({ days: 1 }).toMillis(),
  });
  const times = [...slots.keys()].map((ms) => DateTime.fromMillis(ms, { zone: Z }).toFormat('HH:mm'));
  assert.deepEqual(times, ['08:00', '08:30', '10:00', '10:30', '11:00', '11:30']);
});

test('booking opretter aftalen i den rigtige Bookings-side', async () => {
  const entry = (await getCatalog()).find((e) => e.id === 'privat:svc-1');
  // createAppointment bruger Date.now(); flyt "nu" til dagen før, så testen ikke afhænger af dags dato.
  const realNow = Date.now;
  const fakeNow = local('00:00').minus({ days: 1 }).toMillis();
  Date.now = () => fakeNow;
  try {
    const res = await createAppointment(entry, local('10:00').toMillis(), { name: 'Test', email: 't@example.com' });
    assert.match(posted.url, /bookingBusinesses\/Thomasmeetingbook@haulund-aadorf\.dk\/appointments$/);
    assert.equal(posted.body.serviceId, 'svc-1');
    assert.equal(posted.body.startDateTime.dateTime, `${day}T09:00:00.0000000+00:00`);
    assert.equal(posted.body.endDateTime.dateTime, `${day}T09:30:00.0000000+00:00`);
    assert.deepEqual(posted.body.staffMemberIds, ['staff-1']);
    assert.equal(posted.body.customers[0].emailAddress, 't@example.com');
    assert.equal(res.joinUrl, 'https://teams.example/join');

    await assert.rejects(
      createAppointment(entry, local('09:00').toMillis(), { name: 'Test', email: 't@example.com' }),
      (err) => err.status === 409,
    );
  } finally {
    Date.now = realNow;
  }
});
