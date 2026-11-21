import { visit } from '../content.js';

export default function Visit() {
  const map = `https://www.openstreetmap.org/search?query=${encodeURIComponent(visit.address)}`;
  return (
    <section className="visit" id="visit" aria-labelledby="visit-title">
      <h2 id="visit-title">Come and see us</h2>
      <p>
        <strong>{visit.address}</strong>
        <br />
        {visit.area}
      </p>
      <p>
        <a href={`mailto:${visit.email}`}>{visit.email}</a> · <a href={`tel:${visit.phone.replace(/[^\d+]/g, '')}`}>{visit.phone}</a>
      </p>
      <a className="button secondary" href={map} target="_blank" rel="noreferrer">
        Open the map
      </a>
    </section>
  );
}
