// Konfiguration for den samlede booking.
//
// Mødetyper og Bookings-sider er offentlige (de står allerede i Booking/index.html).
// Postkasser, ICS-link og app-hemmeligheder kommer fra app settings og ligger aldrig i repoet.

export const ZONE = process.env.BOOKING_TIMEZONE || 'Europe/Copenhagen';

export const TENANTS = {
  haulund: process.env.TENANT_HAULUND || 'dbfb3e09-8afe-4c61-8ece-9ed3b5e940bd',
  timewinder: process.env.TENANT_TIMEWINDER || '67a0d407-4ca4-4ee5-bf31-c3bbe3e0120e',
};

// Mødetyper der kan bookes gennem API'et. Hver peger på en Bookings-side i én tenant,
// og bookingen oprettes dér, så den lander i den rigtige kalender.
export const MEETING_TYPES = [
  {
    key: 'privat',
    label: 'Privat',
    tenant: 'haulund',
    businessId: 'Thomasmeetingbook@haulund-aadorf.dk',
  },
  {
    key: 'timewinder',
    label: 'TimeWinder',
    tenant: 'timewinder',
    businessId: 'BooktidmedThomasfraTimeWinderIT@timewinder.dk',
  },
];

// Kalendere der altid gør Thomas optaget, uanset hvilken mødetype der bookes.
export function busySources() {
  const sources = [];
  if (process.env.MAILBOX_HAULUND) {
    sources.push({ kind: 'graph', name: 'privat', tenant: 'haulund', mailbox: process.env.MAILBOX_HAULUND });
  }
  if (process.env.MAILBOX_TIMEWINDER) {
    sources.push({ kind: 'graph', name: 'timewinder', tenant: 'timewinder', mailbox: process.env.MAILBOX_TIMEWINDER });
  }
  if (process.env.ATP_ICS_URL) {
    sources.push({ kind: 'ics', name: 'atp', url: process.env.ATP_ICS_URL });
  }
  return sources;
}

export const LIMITS = {
  maxDays: 31, // getSchedule tillader under 62 dage; vi holder os godt under
  defaultDays: 14,
};
