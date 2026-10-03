import { JWT } from 'google-auth-library';

const sheet = "'Fall 2026 Teams (Clean)'";
const headers = ['Name', 'Team', 'Role', 'Year', 'Phone', 'GitHub', 'Website', 'Email'];

export function parseRoster(values) {
  if (!values?.length || headers.some((header, i) => values[0][i] !== header)) {
    throw new Error('Roster columns have changed; access decisions are paused.');
  }
  const rows = values.slice(1).map((cells, i) => ({
    row: i + 2, name: cells[0]?.trim() || '', team: cells[1]?.trim() || '',
    role: cells[2]?.trim() || '', year: String(cells[3] || '').trim(),
    phone: cells[4]?.trim() || '', github: cells[5]?.trim() || '',
    website: cells[6]?.trim() || '', email: cells[7]?.trim().toLowerCase() || '',
  })).filter(row => row.email);
  if (new Set(rows.map(row => row.email)).size !== rows.length) {
    throw new Error('Roster contains duplicate email addresses; access decisions are paused.');
  }
  return rows;
}

export function rosterTeams(row, names) {
  return row.team.split(',').map(name => name.trim()).filter(name => names.includes(name));
}

export function rosterFunctions(row, names) {
  const parts = row.role.split(',').map(part => part.trim());
  const mapped = parts.flatMap(part => ({
    SWE: ['Engineering'], 'Tech Lead': ['Engineering'], 'Lead Developer': ['Engineering'],
    Designer: ['Design'], PM: ['Product'], 'PM Lead': ['Product'],
    Marketing: ['Marketing'], Outreach: ['Marketing'],
  })[part] || []);
  return [...new Set(mapped)].filter(name => names.includes(name));
}

export class Roster {
  constructor(config) {
    this.id = config.rosterSpreadsheetId;
    this.auth = new JWT({
      email: config.googleServiceAccount.client_email,
      key: config.googleServiceAccount.private_key,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
  }

  async request(path, options = {}) {
    const { token } = await this.auth.getAccessToken();
    const response = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${this.id}/${path}`, {
      ...options,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    });
    if (!response.ok) {
      const detail = (await response.json().catch(() => null))?.error?.message;
      throw new Error(`Roster request failed (${response.status})${detail ? `: ${detail}` : ''}`);
    }
    return response.json();
  }

  async all() {
    const result = await this.request(`values/${encodeURIComponent(`${sheet}!A1:H`)}`);
    return parseRoster(result.values || []);
  }

  async byEmail(email) {
    return (await this.all()).find(row => row.email === email.toLowerCase()) || null;
  }

  async flag(row) {
    const range = `${sheet}!H${row.row}`;
    const current = await this.request(`values/${encodeURIComponent(range)}`);
    if (current.values?.[0]?.[0]?.trim().toLowerCase() !== row.email) {
      throw new Error('Roster row moved; Status Review was not changed.');
    }
    const header = await this.request(`values/${encodeURIComponent(`${sheet}!J1`)}`);
    if (header.values?.[0]?.[0] !== 'Status Review') throw new Error('Status Review column moved.');
    await this.request(`values/${encodeURIComponent(`${sheet}!J${row.row}`)}?valueInputOption=RAW`, {
      method: 'PUT', body: JSON.stringify({ values: [[true]] }),
    });
  }
}
