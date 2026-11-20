import { hours } from '../content.js';

export default function Hours() {
  return (
    <section className="hours" aria-labelledby="hours-title">
      <h2 id="hours-title">Opening hours</h2>
      <dl>
        {hours.map((h) => (
          <div key={h.days}>
            <dt>{h.days}</dt>
            <dd>{h.time}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
