#!/usr/bin/env node
// A minimal jonobones client — the kind of app the daemon exists to serve.
// Zero dependencies (Node >= 24); speaks plain REST + SSE to /v1.
//
//   JONOBONES_URL=http://127.0.0.1:26637 JONOBONES_TOKEN=... \
//     node examples/jonobones-app.mjs <command>
//
// Commands:
//   notebook add <title>
//   note add --title <t> [--body <b>] [--notebook <id>]
//   note ls [--notebook <id>]
//   note cat <id>
//   attach <noteId> <file>            upload + link into the note body
//   tag <noteId> <title>              find-or-create tag, attach to note
//   userdata set <noteId> <ns> <key> <json>
//   sync [--wait]
//   status
//   watch [--last-event-id <n>]       SSE → NDJSON on stdout
//
// Non-watch commands print one JSON document to stdout. `watch` prints one
// JSON object per line: {"type":"open"} once the stream is live, then
// {"type":"event",...} / {"type":"reset",...}. Diagnostics go to stderr.
// The e2e suite drives this file as a child process; it is deliberately a
// dumb 1:1 mapping onto the API — no retries, no local state.

import { readFileSync } from 'node:fs';
import { basename, extname } from 'node:path';
import { parseArgs } from 'node:util';

const BASE = `${(process.env.JONOBONES_URL ?? 'http://127.0.0.1:26637').replace(/\/+$/, '')}/v1`;
const TOKEN = process.env.JONOBONES_TOKEN;

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function out(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

async function api(method, path, body) {
  const headers = { authorization: `Bearer ${TOKEN}` };
  let payload;
  if (body instanceof FormData) {
    payload = body;
  } else if (body !== undefined) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(`${BASE}${path}`, { method, headers, body: payload });
  const text = await res.text();
  if (!res.ok) fail(`${method} ${path} → ${res.status}: ${text}`);
  return text === '' ? null : JSON.parse(text);
}

const MIME = {
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.pdf': 'application/pdf',
};

async function cmdNotebookAdd(title) {
  out(await api('POST', '/notebooks', { title }));
}

async function cmdNoteAdd(args) {
  const { values } = parseArgs({
    args,
    options: { title: { type: 'string' }, body: { type: 'string' }, notebook: { type: 'string' } },
  });
  if (!values.title) fail('note add requires --title');
  const note = { title: values.title, body: values.body ?? '' };
  if (values.notebook) note.parent_id = values.notebook;
  out(await api('POST', '/notes', note));
}

async function cmdNoteLs(args) {
  const { values } = parseArgs({ args, options: { notebook: { type: 'string' } } });
  const filter = values.notebook ? `&parent_id=${values.notebook}` : '';
  out(await api('GET', `/notes?fields=id,parent_id,title,updated_time${filter}`));
}

async function cmdNoteCat(id) {
  out(await api('GET', `/notes/${id}?fields=id,parent_id,title,body,updated_time,user_data`));
}

async function cmdAttach(noteId, file) {
  const note = await api('GET', `/notes/${noteId}?fields=id,body`);
  const name = basename(file);
  const form = new FormData();
  form.append('props', JSON.stringify({ title: name }));
  form.append('data', new Blob([readFileSync(file)], { type: MIME[extname(file)] ?? 'application/octet-stream' }), name);
  const resource = await api('POST', '/resources', form);
  const body = `${note.body ? `${note.body}\n\n` : ''}[${name}](:/${resource.id})`;
  await api('PATCH', `/notes/${noteId}`, { body });
  out({ resource_id: resource.id, note_id: noteId });
}

async function cmdTag(noteId, title) {
  const tags = await api('GET', '/tags?fields=id,title&limit=1000');
  let tag = tags.items.find((t) => t.title.toLowerCase() === title.toLowerCase());
  tag ??= await api('POST', '/tags', { title });
  await api('POST', `/tags/${tag.id}/notes`, { id: noteId });
  out({ tag_id: tag.id, note_id: noteId });
}

async function cmdUserdataSet(noteId, ns, key, json) {
  let value;
  try {
    value = JSON.parse(json);
  } catch {
    fail(`userdata value is not valid JSON: ${json}`);
  }
  await api('PUT', `/notes/${noteId}/userdata/${ns}/${key}`, { value });
  out(await api('GET', `/notes/${noteId}/userdata/${ns}/${key}`));
}

async function cmdSync(args) {
  const { values } = parseArgs({ args, options: { wait: { type: 'boolean', default: false } } });
  await api('POST', '/sync');
  if (!values.wait) {
    out({ syncing: true });
    return;
  }
  for (let i = 0; i < 240; i++) {
    const status = await api('GET', '/status');
    if (status.sync.state === 'idle' && status.sync.lastCompletedAt) {
      out(status.sync);
      return;
    }
    if (status.sync.state === 'error') fail(`sync error: ${status.sync.lastResult}`);
    await new Promise((r) => setTimeout(r, 250));
  }
  fail('sync did not reach idle');
}

async function cmdStatus() {
  out(await api('GET', '/status'));
}

async function cmdWatch(args) {
  const { values } = parseArgs({ args, options: { 'last-event-id': { type: 'string' } } });
  // ?token= is the EventSource-compatible auth path; with fetch we could use
  // the Authorization header, but exercising the query form keeps this
  // example honest for clients that genuinely cannot set headers.
  const url = new URL(`${BASE}/events`);
  url.searchParams.set('token', TOKEN);
  const headers = { accept: 'text/event-stream' };
  if (values['last-event-id'] !== undefined) headers['last-event-id'] = values['last-event-id'];

  const res = await fetch(url, { headers });
  if (!res.ok || !(res.headers.get('content-type') ?? '').includes('text/event-stream')) {
    fail(`watch failed: ${res.status} ${await res.text()}`);
  }
  out({ type: 'open' });

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    for (;;) {
      const sep = buffer.indexOf('\n\n');
      if (sep === -1) break;
      const block = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      if (block.startsWith(':') || block.startsWith('retry:')) continue; // heartbeat / retry hint
      const frame = {};
      for (const line of block.split('\n')) {
        if (line.startsWith('id: ')) frame.id = line.slice(4);
        else if (line.startsWith('event: ')) frame.event = line.slice(7);
        else if (line.startsWith('data: ')) frame.data = line.slice(6);
      }
      if (frame.event === 'reset') {
        out({ type: 'reset', ...(frame.data ? JSON.parse(frame.data) : {}) });
      } else if (frame.event === 'change' && frame.data) {
        out({ type: 'event', id: Number(frame.id), data: JSON.parse(frame.data) });
      }
    }
  }
  // A watcher's stream ending is abnormal: surface it.
  out({ type: 'closed' });
  process.exit(1);
}

const USAGE = `usage: jonobones-app.mjs <command>
  notebook add <title>
  note add --title <t> [--body <b>] [--notebook <id>]
  note ls [--notebook <id>]
  note cat <id>
  attach <noteId> <file>
  tag <noteId> <title>
  userdata set <noteId> <ns> <key> <json>
  sync [--wait]
  status
  watch [--last-event-id <n>]
env: JONOBONES_URL (default http://127.0.0.1:26637), JONOBONES_TOKEN (required)`;

if (!TOKEN) fail(`JONOBONES_TOKEN is required\n\n${USAGE}`);

const [command, ...rest] = process.argv.slice(2);
switch (`${command} ${rest[0] ?? ''}`.trim()) {
  case 'notebook add':
    await cmdNotebookAdd(rest[1] ?? fail('notebook add requires a title'));
    break;
  case 'note add':
    await cmdNoteAdd(rest.slice(1));
    break;
  case 'note ls':
    await cmdNoteLs(rest.slice(1));
    break;
  case 'note cat':
    await cmdNoteCat(rest[1] ?? fail('note cat requires an id'));
    break;
  case 'userdata set':
    if (rest.length < 5) fail('userdata set requires <noteId> <ns> <key> <json>');
    await cmdUserdataSet(rest[1], rest[2], rest[3], rest[4]);
    break;
  default:
    switch (command) {
      case 'attach':
        if (rest.length < 2) fail('attach requires <noteId> <file>');
        await cmdAttach(rest[0], rest[1]);
        break;
      case 'tag':
        if (rest.length < 2) fail('tag requires <noteId> <title>');
        await cmdTag(rest[0], rest[1]);
        break;
      case 'sync':
        await cmdSync(rest);
        break;
      case 'status':
        await cmdStatus();
        break;
      case 'watch':
        await cmdWatch(rest);
        break;
      default:
        fail(USAGE);
    }
}
