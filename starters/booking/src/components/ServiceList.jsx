import { services } from '../data.js';

export default function ServiceList({ selected, onSelect }) {
  return (
    <section className="card">
      <h2>1. Choose a service</h2>
      <ul className="services">
        {services.map((s) => (
          <li key={s.id}>
            <button type="button" className="option" aria-pressed={selected?.id === s.id} onClick={() => onSelect(s)}>
              <span className="name">{s.name}</span>
              <span className="detail">
                {s.minutes} min · {s.price ? `$${s.price}` : 'Free'}
              </span>
              <span className="note">{s.note}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
