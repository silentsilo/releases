# silentsilo.releases

The update endpoint for [SilentSilo](https://github.com/silentsilo/desktop),
running at `releases.silentsilo.com` as a Cloudflare Worker.

Every installed copy asks it once a day whether a newer version exists. This
repository is public so that the answer to "what does that request tell you
about me" can be read rather than believed.

## What it does

```
GET /{target}/{arch}/{installed_version}
```

`204` when the caller is already current, or when nothing is published for
its platform. A Tauri updater manifest when a newer version exists, carrying
only the caller's own platform entry.

That is the whole endpoint. It is deliberately dumb: every update is verified
by the app against a signing key compiled into the binary, so this service
serving the wrong bytes can break updating and cannot install anything.

## What it records

One datapoint per request, in `src/index.ts`, and this is all of it:

- the platform, as `target-arch`
- the version that asked
- the outcome: `no-release`, `up-to-date` or `update-offered`

No IP addresses, no identifiers, no cookies, nothing that distinguishes one
install from another. Counting requests rather than people is the whole
design, and the cost of it is that the number is an estimate.

The check can be turned off in the app's settings, which removes that install
from the count entirely.

## The limit of publishing this

Reading the source tells you what this code does. It does not prove that this
code is what runs at `releases.silentsilo.com`, because Cloudflare offers no
way to attest that. What publishing buys is that a claim and the code behind
it can be compared by anyone who cares to, which makes a false claim
expensive rather than impossible.

Where it matters most, the app does not rely on trusting this service at all:
signatures are checked on the client, against a key this endpoint never sees.

## Dev

```bash
npm install
npm test        # version ordering, and every answer the endpoint gives
npm run typecheck
npm run dev     # local worker, local KV
```

## Licence

MIT, see [LICENSE](LICENSE).
