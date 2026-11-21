import Hero from './components/Hero.jsx';
import Hours from './components/Hours.jsx';
import Offerings from './components/Offerings.jsx';
import Visit from './components/Visit.jsx';
import { site } from './content.js';

export default function App() {
  return (
    <>
      <Hero />
      <main>
        <Offerings />
        <Hours />
        <Visit />
      </main>
      <footer>
        © {new Date().getFullYear()} {site.name}
      </footer>
    </>
  );
}
