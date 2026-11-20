import { daysAhead, hours, slotMinutes } from './data.js';

const KEY = 'bookings';

/** Bookings are kept in this browser. Swap these two functions for a real backend later. */
export function loadBookings() {
  try {
    const list = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

export function saveBookings(list) {
  localStorage.setItem(KEY, JSON.stringify(list));
}

function at(day, hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  const d = new Date(day);
  d.setHours(h, m, 0, 0);
  return d;
}

/** The days people can book: open days from today on. */
export function openDays(now = new Date()) {
  const days = [];
  for (let i = 0; i < daysAhead; i++) {
    const day = new Date(now);
    day.setHours(0, 0, 0, 0);
    day.setDate(day.getDate() + i);
    if (hours[day.getDay()]) days.push(day);
  }
  return days;
}

/** Start times on a day that fit the service, aren't in the past and don't overlap a booking. */
export function openSlots(day, service, bookings, now = new Date()) {
  const open = hours[day.getDay()];
  if (!open || !service) return [];
  const close = at(day, open.close);
  const taken = bookings.map((b) => [new Date(b.start), new Date(b.end)]);
  const slots = [];
  for (let start = at(day, open.open); start < close; start = new Date(start.getTime() + slotMinutes * 60_000)) {
    const end = new Date(start.getTime() + service.minutes * 60_000);
    if (end > close || start <= now) continue;
    if (taken.some(([s, e]) => start < e && end > s)) continue;
    slots.push(start);
  }
  return slots;
}

export const formatDay = (d) => d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
export const formatTime = (d) => d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
