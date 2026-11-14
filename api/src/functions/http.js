import { app } from '@azure/functions';
import { DateTime } from 'luxon';
import { getCatalog, publicCatalog, findSlots, createAppointment, ZONE } from '../booking.js';
import { LIMITS } from '../config.js';

const json = (status, body) => ({ status, jsonBody: body, headers: { 'Cache-Control': 'no-store' } });

function fail(context, err) {
  context.error(err);
  const status = err.status && err.status < 500 ? err.status : 502;
  return json(status, { error: status === 502 ? 'Kalenderopslaget fejlede. Prøv igen om lidt.' : err.message });
}

async function findEntry(id, context) {
  const catalog = await getCatalog((m) => context.warn(m));
  const entry = catalog.find((e) => e.id === id);
  if (!entry) {
    const err = new Error('Ukendt mødetype');
    err.status = 404;
    throw err;
  }
  return entry;
}

// Best effort: én instans husker de seneste bookinger pr. IP.
const recent = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const hits = (recent.get(ip) || []).filter((t) => now - t < 60 * 60_000);
  hits.push(now);
  recent.set(ip, hits);
  return hits.length > 5;
}

app.http('catalog', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'catalog',
  handler: async (_req, context) => {
    try {
      return json(200, { timeZone: ZONE, services: publicCatalog(await getCatalog((m) => context.warn(m))) });
    } catch (err) {
      return fail(context, err);
    }
  },
});

app.http('slots', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'slots',
  handler: async (req, context) => {
    try {
      const entry = await findEntry(req.query.get('service') || '', context);
      const days = Math.min(Math.max(Number(req.query.get('days')) || LIMITS.defaultDays, 1), LIMITS.maxDays);
      const fromParam = req.query.get('from');
      let from = fromParam ? DateTime.fromISO(fromParam, { zone: ZONE }) : DateTime.now().setZone(ZONE);
      if (!from.isValid) return json(400, { error: 'Ugyldig dato' });
      from = from.startOf('day');
      const to = from.plus({ days });

      const { slots, durationMin } = await findSlots(entry, from.toMillis(), to.toMillis(), {
        log: (m) => context.warn(m),
      });
      const byDay = new Map();
      for (const ms of [...slots.keys()].sort((a, b) => a - b)) {
        const dt = DateTime.fromMillis(ms, { zone: ZONE });
        const key = dt.toISODate();
        if (!byDay.has(key)) byDay.set(key, []);
        byDay.get(key).push(dt.toISO({ suppressMilliseconds: true }));
      }
      return json(200, {
        timeZone: ZONE,
        durationMinutes: durationMin,
        from: from.toISODate(),
        to: to.toISODate(),
        days: [...byDay].map(([date, starts]) => ({ date, slots: starts })),
      });
    } catch (err) {
      return fail(context, err);
    }
  },
});

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

app.http('book', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'book',
  handler: async (req, context) => {
    try {
      const b = await req.json().catch(() => ({}));
      if (b.website) return json(200, { ok: true }); // honeypot: bots får et stille "ok"

      const name = String(b.name || '').trim().slice(0, 100);
      const email = String(b.email || '').trim().slice(0, 200);
      const phone = String(b.phone || '').trim().slice(0, 40);
      const notes = String(b.notes || '').trim().slice(0, 2000);
      if (!name || !EMAIL.test(email)) return json(400, { error: 'Navn og en gyldig e-mail er påkrævet' });

      const start = DateTime.fromISO(String(b.start || ''), { setZone: true });
      if (!start.isValid) return json(400, { error: 'Ugyldigt tidspunkt' });

      const ip = (req.headers.get('x-forwarded-for') || '').split(',')[0].split(':')[0].trim() || 'ukendt';
      if (rateLimited(ip)) return json(429, { error: 'For mange bookinger. Prøv igen senere.' });

      const entry = await findEntry(String(b.service || ''), context);
      const result = await createAppointment(entry, start.toMillis(), { name, email, phone, notes }, (m) =>
        context.warn(m),
      );
      context.log(`Booket ${entry.id} ${result.start}`);
      return json(201, { ok: true, ...result });
    } catch (err) {
      return fail(context, err);
    }
  },
});
