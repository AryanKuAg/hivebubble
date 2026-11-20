import { useMemo, useState } from 'react';
import BookingForm from './components/BookingForm.jsx';
import DayPicker from './components/DayPicker.jsx';
import MyBookings from './components/MyBookings.jsx';
import ServiceList from './components/ServiceList.jsx';
import TimeSlots from './components/TimeSlots.jsx';
import { formatDay, formatTime, loadBookings, openDays, openSlots, saveBookings } from './bookings.js';
import { business } from './data.js';

export default function App() {
  const [bookings, setBookings] = useState(loadBookings);
  const [service, setService] = useState(null);
  const [day, setDay] = useState(null);
  const [slot, setSlot] = useState(null);
  const [confirmed, setConfirmed] = useState(null);

  const days = useMemo(() => openDays(), []);
  const slots = useMemo(() => (day && service ? openSlots(day, service, bookings) : []), [day, service, bookings]);

  function update(next) {
    setBookings(next);
    saveBookings(next);
  }

  function book(details) {
    const end = new Date(slot.getTime() + service.minutes * 60_000);
    const booking = { id: crypto.randomUUID(), service: service.name, start: slot.toISOString(), end: end.toISOString(), ...details };
    update([...bookings, booking].sort((a, b) => a.start.localeCompare(b.start)));
    setConfirmed(booking);
    setService(null);
    setDay(null);
    setSlot(null);
  }

  return (
    <main>
      <header className="intro">
        <h1>{business.name}</h1>
        <p>{business.tagline}</p>
      </header>

      {confirmed ? (
        <section className="card confirmed" aria-live="polite">
          <h2>You're booked in</h2>
          <p>
            {confirmed.service} on {formatDay(new Date(confirmed.start))} at {formatTime(new Date(confirmed.start))}. See you then,{' '}
            {confirmed.name.split(' ')[0]}.
          </p>
          <button type="button" onClick={() => setConfirmed(null)}>
            Book another visit
          </button>
        </section>
      ) : (
        <>
          <ServiceList
            selected={service}
            onSelect={(s) => {
              setService(s);
              setSlot(null);
            }}
          />
          {service && (
            <DayPicker
              days={days}
              selected={day}
              onSelect={(d) => {
                setDay(d);
                setSlot(null);
              }}
            />
          )}
          {service && day && <TimeSlots slots={slots} selected={slot} onSelect={setSlot} />}
          {slot && <BookingForm service={service} slot={slot} onBook={book} />}
        </>
      )}

      <MyBookings bookings={bookings} onCancel={(id) => update(bookings.filter((b) => b.id !== id))} />

      <footer>
        {business.address} · {business.phone}
      </footer>
    </main>
  );
}
