import { offerings } from '../content.js';

export default function Offerings() {
  return (
    <section className="offerings" aria-labelledby="offerings-title">
      <h2 id="offerings-title">What we offer</h2>
      <ul>
        {offerings.map((o) => (
          <li key={o.title}>
            <h3>{o.title}</h3>
            <p>{o.text}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}
