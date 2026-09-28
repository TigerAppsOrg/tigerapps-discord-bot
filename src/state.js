import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';

export class State {
  constructor(file) {
    this.file = file;
    try { this.data = JSON.parse(readFileSync(file, 'utf8')); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      this.data = { links: {}, oauth: {}, onboarding: {}, actions: {}, panelId: null, missingRoster: [], rolloutStartedAt: null };
    }
  }

  get() { return this.data; }

  update(change) {
    // ponytail: one process owns this JSON file; use a database if multiple replicas are needed.
    const next = structuredClone(this.data);
    const result = change(next);
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const temp = `${this.file}.${process.pid}.${randomBytes(4).toString('hex')}`;
    writeFileSync(temp, JSON.stringify(next), { mode: 0o600 });
    renameSync(temp, this.file);
    this.data = next;
    return result;
  }

  linkedByDiscord(discordId) {
    return Object.entries(this.data.links).find(([, link]) => link.discordId === discordId)?.[1] || null;
  }

  link(sub, email, discordId) {
    return this.update(data => {
      const boardLink = `board:${email}`;
      if (sub !== boardLink && data.links[boardLink]?.discordId === discordId) delete data.links[boardLink];
      if (data.links[sub] && data.links[sub].discordId !== discordId) throw new Error('This Princeton account is already linked to another Discord account.');
      if (Object.entries(data.links).some(([otherSub, link]) => otherSub !== sub && link.discordId === discordId)) {
        throw new Error('This Discord account is already linked to another Princeton account.');
      }
      if (Object.entries(data.links).some(([otherSub, link]) => otherSub !== sub && link.email === email)) {
        throw new Error('This Princeton email is already linked to another Discord account.');
      }
      data.links[sub] = { email, discordId };
    });
  }

  cleanExpired() {
    this.update(data => {
      const now = Date.now();
      for (const key of ['oauth', 'onboarding', 'actions']) {
        for (const [id, value] of Object.entries(data[key])) {
          if (value.expiresAt < now && !(key === 'actions' && ['executing', 'sending', 'uncertain'].includes(value.status))) delete data[key][id];
        }
      }
    });
  }
}
