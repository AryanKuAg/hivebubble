import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { pluginDir, registryProblems, resourcesDir, skillRegistry, starterRegistry } from './registry.js';
import { frontmatter } from './skills.js';
import { pickStarter } from './starters.js';

describe('the real registry', () => {
  it('has no problems: pinned commits, permissive licenses, review dates, starters that exist', () => {
    assert.deepEqual(registryProblems(), []);
    assert.ok(skillRegistry().length >= 2);
    assert.ok(starterRegistry().starters.length >= 3);
  });
  it('picks the booking starter for booking requests and the site starter for websites', () => {
    assert.equal(pickStarter('make me a booking app for my salon').id, 'booking');
    assert.equal(pickStarter('build a new website for my yoga studio from scratch').id, 'landing');
    assert.equal(pickStarter('an app to track my plants').id, 'vite-react-ts');
  });
  it("ships Hivebubble's own skills as a plugin with matching names", () => {
    const manifest = JSON.parse(readFileSync(path.join(pluginDir(), '.claude-plugin/plugin.json'), 'utf8'));
    assert.equal(manifest.name, 'hivebubble');
    const skills = readdirSync(path.join(pluginDir(), 'skills'));
    assert.deepEqual(skills.sort(), ['explain', 'house-style', 'verify']);
    for (const name of skills) {
      const md = frontmatter(readFileSync(path.join(pluginDir(), 'skills', name, 'SKILL.md'), 'utf8'));
      assert.equal(md.name, name);
      assert.ok((md.description ?? '').length > 40, `${name} needs a description the model can match on`);
    }
  });
  it('has local starters that start with `npm run dev`', () => {
    for (const s of starterRegistry().starters) {
      if (!('local' in s.source)) continue;
      const pkg = JSON.parse(readFileSync(path.join(resourcesDir(), s.source.local, 'package.json'), 'utf8'));
      assert.ok(pkg.scripts?.dev, `${s.id} has a dev script`);
      assert.ok(existsSync(path.join(resourcesDir(), s.source.local, 'index.html')), `${s.id} has an index.html`);
    }
  });
});
