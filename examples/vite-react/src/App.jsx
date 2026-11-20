const breads = [
  { name: 'Sourdough loaf', note: '48-hour ferment, crackly crust', price: '$9' },
  { name: 'Honey oat buns', note: 'Soft, sweet, baked at dawn', price: '$6' },
  { name: 'Seeded rye', note: 'Dense, nutty and keeps for days', price: '$8' },
];

export default function App() {
  return (
    <main>
      <header className="hero">
        <p className="eyebrow">Neighbourhood bakery</p>
        <h1>Welcome to Honey &amp; Crumb</h1>
        <p className="lede">Small-batch bread, baked every morning with local honey.</p>
        <a className="button" href="#menu">See today's bread</a>
      </header>

      <section id="menu" className="menu">
        <h2>Today's bread</h2>
        <ul>
          {breads.map((bread) => (
            <li key={bread.name}>
              <h3>{bread.name}</h3>
              <p>{bread.note}</p>
              <span className="price">{bread.price}</span>
            </li>
          ))}
        </ul>
      </section>

      <footer>Open Tuesday to Sunday, 7am until we sell out.</footer>
    </main>
  );
}
