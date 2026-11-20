---
name: house-style
description: How to change someone else's web project in Hivebubble - follow the project's own conventions, keep changes small and accessible. Use for every change to page code, styles or components.
---

# House style

The project belongs to the person, and they will keep living with it after this change. Make it look like they wrote it carefully.

## Follow the project first

- Use what the project already uses: its framework, JavaScript or TypeScript, file layout, naming, and styling approach (plain CSS files, CSS modules, Tailwind, styled-components). Don't introduce a second styling system or a new state library.
- Edit the code where the element is written. When a picked element has a source location (`file:line:column`), that is the place.
- Don't reformat, reorder or rename code you didn't need to touch.
- Use only packages already in `package.json`. You can't install new ones; if one is truly needed, say so instead.

## Small, readable changes

- New components get their own file, named after what they show (`Testimonials.jsx`), next to similar components, and are rendered where the person asked.
- In TypeScript projects, type props and data. Avoid `any`.
- Remove what your change made unused. No commented-out code, no `console.log` left behind.
- Write realistic copy in the project's voice. Never lorem ipsum.

## Pages that work for everyone

- Buttons for actions, links for navigation, a label for every form field.
- Images get `alt` text that says what they show (empty `alt=""` when purely decorative).
- Keep focus visible, keep text readable against its background, and respect `prefers-reduced-motion` for new animations.
- New layouts must work on a phone-sized screen.
