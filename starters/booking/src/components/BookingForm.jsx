import { useState } from 'react';
import { formatDay, formatTime } from '../bookings.js';

export default function BookingForm({ service, slot, onBook }) {
  const [name, setName] = useState('');
  const [contact, setContact] = useState('');
  const [notes, setNotes] = useState('');

  function submit(e) {
    e.preventDefault();
    if (!name.trim() || !contact.trim()) return;
    onBook({ name: name.trim(), contact: contact.trim(), notes: notes.trim() });
  }

  return (
    <section className="card">
      <h2>4. Your details</h2>
      <p className="muted">
        {service.name} on {formatDay(slot)} at {formatTime(slot)}
      </p>
      <form onSubmit={submit} className="form">
        <label>
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" required />
        </label>
        <label>
          Email or phone
          <input value={contact} onChange={(e) => setContact(e.target.value)} autoComplete="email" required />
        </label>
        <label>
          Anything we should know? <span className="muted">(optional)</span>
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} />
        </label>
        <button type="submit" className="primary">
          Confirm booking
        </button>
      </form>
    </section>
  );
}
