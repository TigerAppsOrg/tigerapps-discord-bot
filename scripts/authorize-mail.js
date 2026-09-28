import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { OAuth2Client } from 'google-auth-library';

const { GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET } = process.env;
if (!GMAIL_CLIENT_ID || !GMAIL_CLIENT_SECRET) throw new Error('Set GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET first.');

const redirect = 'http://localhost:3741/callback';
const state = randomBytes(24).toString('base64url');
const client = new OAuth2Client(GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, redirect);
const url = client.generateAuthUrl({
  access_type: 'offline', prompt: 'consent',
  scope: ['openid', 'email', 'https://www.googleapis.com/auth/gmail.send'], state,
});

const server = createServer(async (request, response) => {
  const incoming = new URL(request.url, redirect);
  if (incoming.pathname !== '/callback' || incoming.searchParams.get('state') !== state) {
    response.writeHead(400); response.end('Invalid authorization response.'); return;
  }
  try {
    const { tokens } = await client.getToken(incoming.searchParams.get('code') || '');
    const ticket = await client.verifyIdToken({ idToken: tokens.id_token, audience: GMAIL_CLIENT_ID });
    const identity = ticket.getPayload();
    if (identity?.email_verified !== true || identity.email?.toLowerCase() !== 'it.admin@princetonusg.com' || !tokens.refresh_token) {
      throw new Error('Use the TigerApps mailbox and grant offline mail sending.');
    }
    mkdirSync('data', { recursive: true, mode: 0o700 });
    writeFileSync('data/gmail-refresh-token', tokens.refresh_token, { mode: 0o600 });
    response.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
    response.end('TigerApps mail authorization saved locally. You can close this window.');
    console.log('Saved data/gmail-refresh-token. Keep it outside Git.');
  } catch {
    response.writeHead(400, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
    response.end('Authorization failed. Check the account and OAuth configuration, then retry.');
    console.error('TigerApps mail authorization failed.');
  }
  server.close();
});

server.listen(3741, '127.0.0.1', () => console.log(`Open this Google authorization URL in your browser:\n${url}`));
