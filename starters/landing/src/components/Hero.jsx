import { site } from '../content.js';

export default function Hero() {
  return (
    <header className="hero">
      <p className="name">{site.name}</p>
      <h1>{site.headline}</h1>
      <p className="intro">{site.intro}</p>
      <a className="button" href={site.action.href}>
        {site.action.label}
      </a>
    </header>
  );
}
