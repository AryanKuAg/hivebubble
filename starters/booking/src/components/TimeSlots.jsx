import { formatTime } from '../bookings.js';

export default function TimeSlots({ slots, selected, onSelect }) {
  return (
    <section className="card">
      <h2>3. Pick a time</h2>
      {slots.length === 0 ? (
        <p className="muted">No free times left that day. Try another day.</p>
      ) : (
        <div className="slots">
          {slots.map((t) => (
            <button key={t.toISOString()} type="button" className="chip" aria-pressed={selected?.getTime() === t.getTime()} onClick={() => onSelect(t)}>
              {formatTime(t)}
            </button>
          ))}
        </div>
      )}
    </section>
  );
}
