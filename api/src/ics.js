// Optaget-tid fra en publiceret kalender (ICS), fx ATP-kalenderen.
import ical from 'node-ical';

const FREE_STATES = new Set(['FREE', 'WORKINGELSEWHERE']);

export function busyFromIcs(data, fromMs, toMs) {
  const from = new Date(fromMs);
  const to = new Date(toMs);
  const out = [];
  for (const ev of Object.values(data)) {
    if (ev.type !== 'VEVENT' || !ev.start) continue;
    if (ev.recurrenceid) continue; // overrides håndteres af expandRecurringEvent på basis-eventet
    const instances = ical.expandRecurringEvent(ev, { from, to, expandOngoing: true });
    for (const inst of instances) {
      const e = inst.event || ev;
      if (String(e.status || '').toUpperCase() === 'CANCELLED') continue;
      if (String(e.transparency || '').toUpperCase() === 'TRANSPARENT') continue;
      const busyStatus = String(e['MICROSOFT-CDO-BUSYSTATUS'] || e['X-MICROSOFT-CDO-BUSYSTATUS'] || '').toUpperCase();
      if (FREE_STATES.has(busyStatus)) continue;
      const start = inst.start.getTime();
      const end = (inst.end || inst.start).getTime();
      if (end <= fromMs || start >= toMs) continue;
      out.push({ start, end: Math.max(end, start + 60_000) });
    }
  }
  return out;
}

export async function fetchIcsBusy(url, fromMs, toMs) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 10_000);
  try {
    const data = await ical.async.fromURL(url, { signal: ac.signal });
    return busyFromIcs(data, fromMs, toMs);
  } finally {
    clearTimeout(timer);
  }
}
