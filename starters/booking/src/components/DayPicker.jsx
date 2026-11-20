import { formatDay } from '../bookings.js';

export default function DayPicker({ days, selected, onSelect }) {
  return (
    <section className="card">
      <h2>2. Pick a day</h2>
      <div className="days">
        {days.map((d) => (
          <button key={d.toISOString()} type="button" className="chip" aria-pressed={selected?.getTime() === d.getTime()} onClick={() => onSelect(d)}>
            {formatDay(d)}
          </button>
        ))}
      </div>
    </section>
  );
}
