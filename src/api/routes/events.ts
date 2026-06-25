// SPDX-FileCopyrightText: 2026 Gary Frattarola <garyf@parkviewlab.ai>
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { EventHub } from '../../events/hub.js';
import type { JournalEvent } from '../../events/journal.js';
import { ApiError } from '../errors.js';
import { DEFAULT_LIMIT, MAX_LIMIT } from '../pagination.js';

const HEARTBEAT_MS = 30_000;

function parseCursor(raw: unknown, name: string): number {
  if (raw === undefined) return 0;
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) {
    throw new ApiError(400, 'bad_request', `${name} must be a non-negative integer`);
  }
  return parseInt(raw, 10);
}

function sseFrame(event: JournalEvent): string {
  return `id: ${event.id}\nevent: change\ndata: ${JSON.stringify(event)}\n\n`;
}

// The reset frame carries the id to resume from after the client reloads.
function sseReset(resumeFrom: number): string {
  return `event: reset\ndata: ${JSON.stringify({ resumeFrom })}\n\n`;
}

async function handleSse(hub: EventHub, request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const query = request.query as Record<string, unknown>;
  const lastEventIdHeader = request.headers['last-event-id'];
  const cursor = parseCursor(
    typeof lastEventIdHeader === 'string' && lastEventIdHeader !== '' ? lastEventIdHeader : query.cursor,
    'cursor',
  );

  const raw = reply.raw;
  raw.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  raw.write('retry: 3000\n\n');

  // Buffer live events during replay so nothing falls between journal reads
  // and the live subscription; ids are deduped by the lastSent watermark.
  let lastSent = cursor;
  let replaying = true;
  const backlog: JournalEvent[] = [];
  const send = (event: JournalEvent) => {
    if (event.id <= lastSent) return;
    raw.write(sseFrame(event));
    lastSent = event.id;
  };
  const unsubscribe = hub.subscribe((event) => {
    if (replaying) backlog.push(event);
    else send(event);
  });

  const heartbeat = setInterval(() => raw.write(': ping\n\n'), HEARTBEAT_MS);
  heartbeat.unref();

  request.raw.on('close', () => {
    clearInterval(heartbeat);
    unsubscribe();
  });

  try {
    if (cursor > 0 && !(await hub.journal.isResumable(cursor))) {
      const newest = (await hub.journal.newestId()) ?? 0;
      raw.write(sseReset(newest));
      lastSent = newest;
    } else {
      for (;;) {
        const page = await hub.journal.listAfter(lastSent, 500);
        if (!page.length) break;
        for (const event of page) send(event);
      }
    }
  } finally {
    replaying = false;
    for (const event of backlog) send(event);
  }
  // The connection stays open; Fastify must not touch the hijacked socket.
}

export function registerEventRoutes(v1: FastifyInstance, hub: EventHub): void {
  v1.get('/events', async (request, reply) => {
    const accept = request.headers.accept ?? '';
    if (accept.includes('text/event-stream')) {
      // Hijack: we own the raw socket from here on.
      reply.hijack();
      await handleSse(hub, request, reply);
      return reply;
    }

    const query = request.query as Record<string, unknown>;
    const cursor = parseCursor(query.cursor, 'cursor');
    let limit = DEFAULT_LIMIT;
    if (query.limit !== undefined) {
      if (typeof query.limit !== 'string' || !/^\d+$/.test(query.limit)) {
        throw new ApiError(400, 'bad_request', 'limit must be a positive integer');
      }
      limit = parseInt(query.limit, 10);
      if (limit < 1 || limit > MAX_LIMIT) throw new ApiError(400, 'bad_request', `limit must be 1-${MAX_LIMIT}`);
    }

    if (cursor > 0 && !(await hub.journal.isResumable(cursor))) {
      const newest = (await hub.journal.newestId()) ?? 0;
      return { reset: true, items: [], cursor: newest, has_more: false };
    }

    const items = await hub.journal.listAfter(cursor, limit + 1);
    const page = items.slice(0, limit);
    return {
      items: page,
      cursor: page.length ? page[page.length - 1]!.id : cursor,
      has_more: items.length > limit,
    };
  });
}
