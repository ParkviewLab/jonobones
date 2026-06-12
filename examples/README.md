# Examples

## jonobones-app.mjs

A minimal client for the jonobones API — zero dependencies, plain
`fetch` + SSE, Node ≥ 24. It exists to show what consuming the daemon
looks like, and the e2e test suite drives it as a real second client.

```sh
export JONOBONES_URL=http://127.0.0.1:26637
export JONOBONES_TOKEN=…        # from config.json5 / lock.json in the profile dir

node examples/jonobones-app.mjs notebook add "inbox"
node examples/jonobones-app.mjs note add --title "hello" --body "from the example app" --notebook <id>
node examples/jonobones-app.mjs attach <noteId> ./photo.png
node examples/jonobones-app.mjs tag <noteId> important
node examples/jonobones-app.mjs userdata set <noteId> myapp pinned true
node examples/jonobones-app.mjs sync --wait
node examples/jonobones-app.mjs watch        # NDJSON change feed over SSE
```

`watch` prints one JSON object per line: `{"type":"open"}` when the
stream is live, then `{"type":"event","id":…,"data":{…}}` for each
change (and `{"type":"reset",…}` if your cursor has aged out — full
reload time). Reconnect with `--last-event-id <n>` to replay what you
missed. Everything else prints one JSON document per invocation.
