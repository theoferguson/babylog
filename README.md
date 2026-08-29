# babylog

Baby event tracker. Log feeds, diapers and pumps; review them on a day timeline.
See [PLAN.md](PLAN.md) for the design and phase breakdown.

## Server

```sh
python3 -m venv .venv && .venv/bin/pip install -r server/requirements.txt
cd server
../.venv/bin/python manage.py migrate
../.venv/bin/python manage.py createsuperuser
../.venv/bin/python manage.py runserver
```

Tests: `../.venv/bin/python manage.py test` (14 tests, no fixtures needed).

Parser self-check, no Django required:
`.venv/bin/python server/events/importers/huckleberry.py`

Palette check (re-run if you change a theme colour): `.venv/bin/python palette-check.py`

### Importing a Huckleberry export

Two paths, same parser and the same content-derived ids, so both are idempotent:

Nothing has been imported into production yet — that waits for the Phase 2
review UI, so the 224 rows get checkboxes and warnings instead of a blind CLI
load.

Real exports are **not kept in this repo** — they're health data about a real
child, and `.gitignore` blocks `*-export.csv`. Keep yours outside the tree and
pass a path. Tests and the parser self-check run against the synthetic fixture in
`server/events/testdata/`.

- **CLI** — `manage.py import_huckleberry ~/path/to/export.csv --household 1 --baby <uuid> [--dry-run]`
- **API** — `POST /api/import/preview/` (multipart `file`) returns parsed rows and
  saves nothing. Each row carries `errors` (shown as red warnings in the review
  list), `already_imported` and `needs_baby`. The app renders them with a
  checkbox each, all checked by default, then posts the checked ones to
  `POST /api/import/commit/` with `{baby, events}`.

  Commit is **per-row**: valid rows save, invalid ones come back in `skipped`
  with their index and reasons, so you can fix and re-send just those.

## Deploy (Fly)

SQLite on a volume, one machine. See PLAN.md for why, and for the pragmas.

```sh
fly volumes create babylog_data --region iad --size 1
fly scale count 1                       # a volume cannot be shared
fly secrets set \
  SECRET_KEY="$(python3 -c 'import secrets;print(secrets.token_urlsafe(50))')" \
  ALLOWED_HOSTS=babylog-honeyed-hillside-7890.fly.dev \
  CSRF_TRUSTED_ORIGINS=https://babylog-honeyed-hillside-7890.fly.dev
fly deploy                              # migrations run at container start
fly ssh console -C "python manage.py createsuperuser"
```

`DATABASE_URL` is set in `fly.toml`, not as a secret — it holds no credentials.

**Backups.** Fly snapshots the volume daily (5-day retention). For a consistent
copy on demand — never copy the `.sqlite3` file directly, the WAL sidecar means
you'd get a torn database:

```sh
fly ssh console -C "python -c \"import sqlite3;sqlite3.connect('/data/babylog.sqlite3').execute('VACUUM INTO \'/data/backup.sqlite3\'')\""
fly ssh sftp get /data/backup.sqlite3
```

## App (Expo)

```sh
cd app
npm install
npx expo start            # then i for iOS simulator, w for web
```

Points at `https://babylog-app.fly.dev` by default. For a local server:

```sh
EXPO_PUBLIC_API_URL=http://localhost:8000 npx expo start
```

Formatting logic has a plain-node check: `node src/format.test.mjs`.
Web build: `npx expo export --platform web`.

| file | |
|---|---|
| `src/theme.js` | the verified palette; every colour comes from here |
| `src/api.js` | fetch wrapper, token storage, endpoint list |
| `src/useActive.js` | polls running timers every 3s, foreground refresh |
| `src/Timeline.js` | the 24h day view |
| `app/nurse.js` | the shared L/R timer |

## iOS build (TestFlight)

Builds run on EAS in the cloud — no Xcode needed locally.

**Prerequisites (yours, one-time):**
1. An Expo account — free, <https://expo.dev/signup>
2. An Apple Developer Program membership — $99/yr, <https://developer.apple.com/programs/>.
   Enrolment can take a day or two, so start it first.

```sh
cd app
npx eas-cli login
npx eas-cli build:configure          # links the project to your Expo account
npx eas-cli build --platform ios --profile production
npx eas-cli submit --platform ios --latest
```

The build prompts for your Apple ID and creates the signing certificate and
provisioning profile for you. `submit.production.ios.ascAppId` is already set to
this app's App Store Connect id (6806627248), so submits no longer ask.

App Store Connect: <https://appstoreconnect.apple.com/apps/6806627248/testflight/ios>
The listing name there is `babylog (c8e5f7)` because `babylog` was taken; the
home screen name comes from `expo.name` and is just `babylog`.

**`react-native-reanimated` and `react-native-worklets` are pinned deliberately**
to the SDK 57 set (4.5.1 / 0.10.1). npm otherwise resolves a newer reanimated
that needs worklets 0.12.x, which fails the native build with
`no member named 'executeSync' in worklets::WorkletRuntime`. Nothing catches this
before a real iOS build: they are transitive deps, so `expo install --check` and
`expo-doctor` both pass, and the web bundle compiles no native code.

Then in App Store Connect → your app → TestFlight, add yourself and your partner
as **internal testers**. Internal testing skips Beta App Review; they install
TestFlight once and updates arrive automatically.

Native builds talk to `expo.extra.apiUrl` (the absolute Fly URL). Only the web
build is compiled `same-origin`.

## Email (invites)

Plain Django SMTP, configured by environment variables — Gmail by default, but
any provider works by overriding `EMAIL_HOST`. With none set, mail is printed to
the log instead of sent.

Gmail needs an **App Password**, not your account password: turn on 2-Step
Verification, then create one at <https://myaccount.google.com/apppasswords>.

```sh
fly secrets set \
  EMAIL_HOST_USER="you@gmail.com" \
  EMAIL_HOST_PASSWORD="the-16-char-app-password" \
  DEFAULT_FROM_EMAIL="babylog <you@gmail.com>" \
  PUBLIC_BASE_URL="https://babylog-app.fly.dev"
```

Gmail rewrites the From header to the authenticated account, so `DEFAULT_FROM_EMAIL`
should be that same address. Sending limit is ~500/day, which is not a constraint here.

## API

| | |
|---|---|
| `POST /api/auth/token/` | username + password → token |
| `POST /api/auth/register/` | join a household with an invite code (public, throttled) |
| `/api/invites/` | email, list, resend and revoke single-use invites |
| `GET/POST /api/events/` | filters: `baby`, `type`, `since`, `until` |
| `GET /api/events/latest/` | one row per type, for the home screen |
| `GET /api/events/active/` | running timers, polled by every device |
| `POST /api/events/{id}/timer/` | `{action: start\|stop, side, at}` — server owns the accumulators |
| `POST /api/events/{id}/finish/` | stop the clock and save |
| `DELETE /api/events/{id}/` | soft delete |
| `/api/babies/`, `/api/households/` | setup |

Volumes, weights and lengths are **always metric** on the wire (ml, g, cm).
`Household.units` is a display preference the client applies.
