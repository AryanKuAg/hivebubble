// Everything about the business lives here, so it's easy to change.
export const business = {
  name: 'Willow Studio',
  tagline: 'Pick a time that suits you. It takes under a minute.',
  address: '14 Linden Lane',
  phone: '(555) 014-2290',
};

export const services = [
  { id: 'first', name: 'First visit', minutes: 30, price: 25, note: 'A relaxed first meeting to get to know you.' },
  { id: 'standard', name: 'Standard appointment', minutes: 45, price: 40, note: 'Our most popular choice.' },
  { id: 'long', name: 'Long appointment', minutes: 90, price: 75, note: 'Plenty of time for bigger plans.' },
];

// Opening hours per weekday (0 is Sunday). Closed days are left out.
export const hours = {
  2: { open: '09:00', close: '17:00' },
  3: { open: '09:00', close: '17:00' },
  4: { open: '10:00', close: '19:00' },
  5: { open: '09:00', close: '17:00' },
  6: { open: '09:00', close: '14:00' },
};

// How far apart appointment start times are, and how far ahead people can book.
export const slotMinutes = 30;
export const daysAhead = 14;
