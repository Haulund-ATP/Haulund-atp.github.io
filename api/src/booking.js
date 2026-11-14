// Samler Bookings-opsætning, ledighed og optaget-tid fra alle kalendere.
import { DateTime } from 'luxon';
import { graph } from './graph.js';
import { fetchIcsBusy } from './ics.js';
import { MEETING_TYPES, TENANTS, ZONE, busySources } from './config.js';
import { isoMinutes, merge, intersect, businessHourWindows, computeSlots } from './slots.js';

const enc = encodeURIComponent;

// ---------- simple tidsbaserede caches ----------
const cache = new Map();
async function cached(key, ttlMs, fn) {
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.value;
  const value = await fn();
  cache.set(key, { value, expires: Date.now() + ttlMs });
  return value;
}
export function clearCache() {
  cache.clear();
}

// ---------- katalog ----------
async function loadBusiness(type) {
  const tenantId = TENANTS[type.tenant];
  const base = `/solutions/bookingBusinesses/${enc(type.businessId)}`;
  const [business, services, staff] = await Promise.all([
    graph(tenantId, 'GET', base),
    graph(tenantId, 'GET', `${base}/services`),
    graph(tenantId, 'GET', `${base}/staffMembers`),
  ]);
  return { type, tenantId, base, business, services: services.value, staff: staff.value };
}

export async function getCatalog(log = console.warn) {
  return cached('catalog', 10 * 60_000, async () => {
    // En Bookings-side der fejler skjules, så de andre mødetyper stadig kan bookes.
    const results = await Promise.allSettled(MEETING_TYPES.map(loadBusiness));
    const businesses = [];
    results.forEach((r, i) => {
      if (r.status === 'fulfilled') businesses.push(r.value);
      else log(`Bookings-side ${MEETING_TYPES[i].key} fejlede: ${r.reason?.message}`);
    });
    if (!businesses.length) throw new Error('Ingen Bookings-sider kunne læses');
    const entries = [];
    for (const b of businesses) {
      for (const s of b.services) {
        if (s.isHiddenFromCustomers) continue;
        entries.push({ id: `${b.type.key}:${s.id}`, business: b, service: s });
      }
    }
    return entries;
  });
}

export function publicCatalog(entries) {
  return entries.map(({ id, business, service }) => ({
    id,
    type: business.type.key,
    typeLabel: business.type.label,
    name: service.displayName,
    description: service.description || '',
    durationMinutes: isoMinutes(service.defaultDuration, 30),
    online: !!service.isLocationOnline,
  }));
}

function policyFor(entry) {
  const p = { ...(entry.business.business.schedulingPolicy || {}), ...(entry.service.schedulingPolicy || {}) };
  return {
    intervalMin: isoMinutes(p.timeSlotInterval, 30),
    minLeadMin: isoMinutes(p.minimumLeadTime, 0),
    maxAdvanceMin: isoMinutes(p.maximumAdvance, 365 * 24 * 60),
    allowStaffSelection: !!p.allowStaffSelection,
  };
}

function staffIdsFor(entry) {
  const ids = entry.service.staffMemberIds?.length
    ? entry.service.staffMemberIds
    : entry.business.staff.map((s) => s.id);
  return ids;
}

// ---------- optaget-tid ----------
// Bookings svarer i virksomhedens tidszone med et visningsnavn, fx "(UTC+01:00) Amsterdam, Berlin ...".
function zoneFromBookings(tz) {
  if (!tz || /^(utc|\(utc\) coordinated universal time)$/i.test(tz.trim())) return 'UTC';
  return ZONE;
}

function bookingsMs(dtz) {
  const zone = zoneFromBookings(dtz.timeZone);
  return DateTime.fromISO(dtz.dateTime, { zone }).toMillis();
}

async function bookingsWindows(entry, fromMs, toMs) {
  const fmt = (ms) => DateTime.fromMillis(ms, { zone: 'UTC' }).toFormat("yyyy-MM-dd'T'HH:mm:ss");
  const res = await graph(entry.business.tenantId, 'POST', `${entry.business.base}/getStaffAvailability`, {
    staffIds: staffIdsFor(entry),
    startDateTime: { dateTime: fmt(fromMs), timeZone: 'UTC' },
    endDateTime: { dateTime: fmt(toMs), timeZone: 'UTC' },
  });
  // Ledig hvis mindst én medarbejder er ledig; vi gemmer også hvem.
  const perStaff = new Map();
  for (const item of res.value || res.staffAvailabilityItem || []) {
    const free = (item.availabilityItems || [])
      .filter((a) => ['available', 'slotsavailable'].includes(String(a.status).toLowerCase()))
      .map((a) => ({ start: bookingsMs(a.startDateTime), end: bookingsMs(a.endDateTime) }));
    perStaff.set(item.staffId, merge(free));
  }
  return perStaff;
}

async function graphBusy(source, fromMs, toMs) {
  const iso = (ms) => DateTime.fromMillis(ms, { zone: 'UTC' }).toFormat("yyyy-MM-dd'T'HH:mm:ss");
  const res = await graph(TENANTS[source.tenant], 'POST', `/users/${enc(source.mailbox)}/calendar/getSchedule`, {
    schedules: [source.mailbox],
    startTime: { dateTime: iso(fromMs), timeZone: 'UTC' },
    endTime: { dateTime: iso(toMs), timeZone: 'UTC' },
    availabilityViewInterval: 15,
  });
  const sched = res.value?.[0];
  if (sched?.error) throw new Error(`getSchedule ${source.name}: ${sched.error.message}`);
  return (sched?.scheduleItems || [])
    .filter((i) => !['free', 'workingelsewhere'].includes(String(i.status).toLowerCase()))
    .map((i) => ({
      start: DateTime.fromISO(i.start.dateTime, { zone: 'UTC' }).toMillis(),
      end: DateTime.fromISO(i.end.dateTime, { zone: 'UTC' }).toMillis(),
    }));
}

// Fejler en kilde, fejler hele opslaget: hellere ingen tider end en dobbeltbooking.
export async function getBusy(fromMs, toMs, log = () => {}) {
  const parts = await Promise.all(
    busySources().map(async (s) => {
      try {
        return s.kind === 'ics' ? await fetchIcsBusy(s.url, fromMs, toMs) : await graphBusy(s, fromMs, toMs);
      } catch (err) {
        log(`Optaget-kilde ${s.name} fejlede: ${err.message}`);
        throw new Error(`Kunne ikke læse kalenderen "${s.name}"`);
      }
    }),
  );
  return merge(parts.flat());
}

// ---------- ledige tider ----------
export async function findSlots(entry, fromMs, toMs, { now = Date.now(), log } = {}) {
  const policy = policyFor(entry);
  const durationMin = isoMinutes(entry.service.defaultDuration, 30);
  const preBufferMin = isoMinutes(entry.service.preBuffer, 0);
  const postBufferMin = isoMinutes(entry.service.postBuffer, 0);

  const [perStaff, busy] = await Promise.all([bookingsWindows(entry, fromMs, toMs), getBusy(fromMs, toMs, log)]);
  const hours = businessHourWindows(entry.business.business.businessHours, fromMs, toMs, ZONE);

  const result = new Map(); // start -> staffId
  for (const [staffId, free] of perStaff) {
    const windows = hours ? intersect(free, hours) : free;
    const starts = computeSlots({
      windows,
      busy,
      durationMin,
      intervalMin: policy.intervalMin,
      preBufferMin,
      postBufferMin,
      minLeadMin: policy.minLeadMin,
      maxAdvanceMin: policy.maxAdvanceMin,
      now,
      fromMs,
      toMs,
      zone: ZONE,
    });
    for (const s of starts) if (!result.has(s)) result.set(s, staffId);
  }
  return { slots: result, durationMin, preBufferMin, postBufferMin, policy };
}

// ---------- oprettelse ----------
export async function createAppointment(entry, startMs, customer, log) {
  const dayStart = DateTime.fromMillis(startMs, { zone: ZONE }).startOf('day');
  const { slots, durationMin, preBufferMin, postBufferMin, policy } = await findSlots(
    entry,
    dayStart.toMillis(),
    dayStart.plus({ days: 1 }).toMillis(),
    { log },
  );
  if (!slots.has(startMs)) {
    const err = new Error('Tiden er ikke længere ledig');
    err.status = 409;
    throw err;
  }

  const s = entry.service;
  const utc = (ms) => ({
    '@odata.type': '#microsoft.graph.dateTimeTimeZone',
    dateTime: DateTime.fromMillis(ms, { zone: 'UTC' }).toFormat("yyyy-MM-dd'T'HH:mm:ss'.0000000+00:00'"),
    timeZone: 'UTC',
  });
  const body = {
    '@odata.type': '#microsoft.graph.bookingAppointment',
    serviceId: s.id,
    startDateTime: utc(startMs),
    endDateTime: utc(startMs + durationMin * 60_000),
    preBuffer: s.preBuffer || `PT${preBufferMin}M`,
    postBuffer: s.postBuffer || `PT${postBufferMin}M`,
    isLocationOnline: !!s.isLocationOnline,
    optOutOfCustomerEmail: false,
    smsNotificationsEnabled: false,
    maximumAttendeesCount: s.maximumAttendeesCount || 1,
    priceType: s.defaultPriceType || 'notSet',
    price: s.defaultPrice || 0,
    customerTimeZone: ZONE,
    customerNotes: customer.notes || '',
    customers: [
      {
        '@odata.type': '#microsoft.graph.bookingCustomerInformation',
        name: customer.name,
        emailAddress: customer.email,
        phone: customer.phone || '',
        notes: customer.notes || '',
        timeZone: ZONE,
      },
    ],
  };
  if (policy.allowStaffSelection) body.staffMemberIds = [slots.get(startMs)];

  const created = await graph(entry.business.tenantId, 'POST', `${entry.business.base}/appointments`, body);
  clearCache(); // ny aftale → frisk optaget-tid næste gang
  return {
    id: created.id,
    start: DateTime.fromMillis(startMs, { zone: ZONE }).toISO(),
    end: DateTime.fromMillis(startMs + durationMin * 60_000, { zone: ZONE }).toISO(),
    joinUrl: created.joinWebUrl || null,
  };
}

export { ZONE };
