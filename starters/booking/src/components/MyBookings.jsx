import { formatDay, formatTime } from '../bookings.js';

export default function MyBookings({ bookings, onCancel }) {
  const upcoming = bookings.filter((b) => new Date(b.end) > new Date());
  if (upcoming.length === 0) return null;
  return (
    <section className="card">
      <h2>Your bookings</h2>
      <ul className="bookings">
        {upcoming.map((b) => (
          <li key={b.id}>
            <span>
              <strong>{b.service}</strong> · {formatDay(new Date(b.start))} at {formatTime(new Date(b.start))}
            </span>
            <button type="button" className="link" onClick={() => onCancel(b.id)}>
              Cancel
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
