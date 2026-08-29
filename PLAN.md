# babylog — project plan

A Huckleberry clone. Log baby events fast, review them on a calendar, derive
insights. Two users (me + wife), shared baby, iOS + browser, works offline.

Rename the repo whenever you think of something better.

---

## Decisions

| Question | Answer | Why |
|---|---|---|
| Client | **Expo + Expo Router + React Native Web** | One codebase → real iOS app *and* a browser build. The only option that satisfies "both phones" + "also accessible via browser" without writing it twice. |
| Distribution | **EAS Build → TestFlight internal testing** ($99/yr Apple) | Internal testers skip App Review. Real app icon, real push. Wife installs TestFlight once, then updates arrive automatically. |
| Web | `expo export --platform web` → static files served by the Django app | Same code, same components. No second frontend. |
| Backend | **Django + DRF on Fly**, **SQLite on a volume** | You know the Django/Fly deploy story. Postgres was the original call; SQLite is right-sized for two writers and ~8k rows/year, and costs ~$0.15/mo against $38 for Fly Managed Postgres. Nothing in the code is Postgres-specific — the whole suite runs on both. |
| Offline | **Server is source of truth. Client = persisted query cache + a write outbox.** | See "Offline" below. This is the biggest complexity decision in the project. |
| Tenancy | `Household` is the tenant boundary from day one | One FK + one queryset filter. Makes "scalable to other users" nearly free without building an org/permissions system now. |
| Auth | Django auth + DRF token, email + password | Trust boundary — not a place to be clever. Social login later if ever. |

### Repo layout

```
babylog/
  server/     Django project (API + serves the web build)
  app/        Expo project (iOS + web)
  PLAN.md
```

Two independent build systems. **Skipped:** monorepo tooling (turborepo, nx,
npm workspaces) — buys nothing when nothing is shared between the two dirs.

---

## Data model

One event table, not eight. This is the entire "scalable for more features" bet.

```python
Household           # the family
Membership          # user <-> household   (two logins: you + wife)
Baby                # household FK, name, dob, avatar_color
                    # -> "configurable number of babies and names" falls out free

Event
  id            UUID          # generated CLIENT-side, so offline creates have real IDs
  household     FK            # tenancy filter, and the owner of baby-less events
  baby          FK NULL       # null for parent events (Pump) -- see below
  type          str           # feed | diaper | pump | sleep | growth | med | milestone | note
  started_at    datetimetz    # stored UTC
  tz            str           # IANA zone it was RECORDED in -- see Timezones
  ended_at      datetimetz?   # null = instant event; set = interval
  payload       JSONB         # type-specific, validated per-type in DRF
  notes         text
  created_by    FK user
  updated_at    datetime      # last-write-wins key
  deleted_at    datetime?     # soft delete, so deletions can sync
```

Indexes: `(household, started_at DESC)`, `(baby, type, started_at DESC)`.

### `baby` is nullable, because Pump exists

The export has 19 `Pump` rows. A pump session has **no baby as its subject** —
it is a parent event that happens to live in the same timeline. Rather than
inventing a `subject` polymorphism, `baby` is nullable and `household` carries
tenancy. Pump rows get `baby=null`.

**Skipped:** a generic subject/actor abstraction. Add one if a second baby-less
type shows up that *isn't* about the pumping parent.

### Payload shapes — derived from your actual export

```
feed      {method: breast|bottle,
           right_sec, left_sec, last_side: L|R,   # breast
           contents: "Breast Milk", volume_oz}    # bottle
diaper    {pee: none|small|medium|large,
           poo: none|small|medium|large,
           color: yellow|brown|green,
           consistency: runny|loose|...}
pump      {left_oz, right_oz}            # labels provisional -- always aggregate the TOTAL
sleep     {}                             # duration derives from start/end
growth    {weight_g, height_cm, head_cm}
med       {name, dose, unit}
milestone {label}
note      {}
```

**Why JSONB and not real columns:** adding an event type becomes a serializer +
a form component, no migration. **When to promote a field to a column:** when you
need to index or aggregate on it in SQL.

**Skipped:** separate table per event type, EAV, a plugin system for event types.

---

## Why SQLite, and what makes it safe here

Two writers, ~22 events a day, ~8,000 rows a year. Postgres is the wrong size for
that; Fly's Managed Postgres is $38/mo and even an unmanaged instance is a second
machine to run. SQLite lives *inside* the app machine — the only added cost is
the volume, about **$0.15/mo**.

Out of the box SQLite would throw `database is locked` the first time you and
your wife log a feed in the same second. Four pragmas and one Django option fix
that, and they are the difference between "toy" and "fine for years":

| setting | why |
|---|---|
| `journal_mode=WAL` | readers never block the writer, or each other |
| `transaction_mode=IMMEDIATE` | takes the write lock up front — **the important one** |
| `busy_timeout=5000` | wait for a lock instead of failing instantly |
| `synchronous=NORMAL` | safe under WAL; survives process crash |

`IMMEDIATE` is the one that isn't obvious. Two transactions that each read then
write will deadlock upgrading a read lock to a write lock, and `busy_timeout`
**cannot** rescue that — SQLite can't resolve it by waiting, so one dies with
`SQLITE_BUSY` regardless. Verified: 4 concurrent writers, 160 rows, no errors.

**The constraint this buys:** exactly one machine (`fly scale count 1`), because
a volume can't be shared. That means brief downtime on deploy and no horizontal
scaling. For a family tracker that is not a real cost.

**Migrations run at container start, not as a Fly `release_command`** — release
machines don't get volumes mounted, so a release-command migrate would build a
throwaway database and leave `/data` untouched, silently.

**Skipped:** Litestream continuous replication. Fly snapshots the volume daily
(5-day retention) and `VACUUM INTO` gives you a consistent copy on demand. Add
Litestream if losing a day of logs ever stops being acceptable.

**The upgrade path**, if this ever outgrows one machine: `DATABASE_URL` is the
only thing that changes. Point it at Postgres, run migrations, `loaddata` the
dump. Nothing in the models, serializers or views is engine-specific.

## Units

**The backend and the API are always metric** — `volume_ml`, `weight_g`,
`height_cm`. Every measurement is stored and transmitted in one unit, always.

`Household.units` (`metric` | `imperial`) is a **display preference the client
applies**. The API never converts and never varies its response by who is
asking, so a stored number means exactly one thing forever. Import converts on
the way in: `3.5oz` becomes `103.51`.

Whichever unit you two prefer at the keyboard, the data underneath doesn't move.
That also means switching the setting is instant and lossless, and a second
household on the other setting costs nothing.

**Skipped:** per-user units (household-level is enough for two people), and
per-field units. `units` is one column.

## Timezones — you travel, so this is not a one-liner

The export's timestamps are **naive local strings** (`2026-08-27 17:46`) with no
zone. That's fine until you fly, and then "how many feeds on Tuesday" becomes
ambiguous.

Store `started_at` in UTC **plus** the IANA zone it was recorded in (`tz`). The
day-timeline and every daily rollup group by *local* date in the event's own
`tz`, not the viewer's current one. A feed at 2am in Lisbon stays on the Lisbon
night where it happened, instead of sliding onto the previous afternoon when you
get home.

Client sends `Intl.DateTimeFormat().resolvedOptions().timeZone` with each write.
Import assumes `America/New_York` for all 224 existing rows.

**Skipped:** letting the user re-assign an event's zone after the fact. Add when
you actually mis-log one on a plane.

## Offline

The requirement is "quickly accessed offline", which is mostly a *read*
requirement with occasional writes (logging a 3am feed in a basement).

**The plan:**
- TanStack Query with a persisted AsyncStorage cache → every screen renders from
  cache instantly, online or off.
- Writes go through an **outbox**: append the mutation to an AsyncStorage list,
  apply it optimistically, flush on reconnect. Client-generated UUIDs make
  retries idempotent.
- Conflict rule: **last-write-wins on `updated_at`, whole event.** Two parents
  editing the same event within seconds of each other is the only losing case,
  and it isn't real.

**Skipped:** SQLite replication, CRDTs, operational transform, a sync engine.
Add when you observe an actual lost edit — not before. This is the single
easiest place to burn a month of evenings on this project.

**One exception: the running nurse timer is server-authoritative**, because it
has to be shared live between two phones (see "A running timer belongs to the
household"). Last-write-wins would corrupt an accumulator that both devices are
adding to. Offline, it degrades to a local timer and reconciles on reconnect —
so you lose the *sharing*, never the timer.

---

## What Huckleberry actually does — and what to copy

Sourced from Huckleberry's own marketing, a UI teardown, and reviews. **Not from
screenshots** — the App Store listing blocked automated fetches. Treat as
structural, not pixel-level; verify against the real app on your phone.

### Logging is bespoke per type

**There is no generic event form.** Each type gets its own screen, shaped to how
that thing is actually recorded. Only nursing has a live timer.

#### Nurse — the only timer, and it is shared

Two big buttons, **L** and **R**. Tap one to start it, tap again to stop; tapping
the other **stops the running side and starts that one**. Then **Save**.

Verified against a real export: 0 of 98 feeds have overlapping sides, so mutual
exclusion is right. 65 use both sides, 33 use one.

Each side is an **accumulator**, not a single stretch — you switch back and
forth, so R→L→R adds into `right_sec`. The export only ever stores per-side
totals, so segment order is not recoverable and not worth storing.

##### A running timer belongs to the household, not the phone

**Anyone with access can start, stop, edit and save the same running timer, and
sees it live on their own device.** You start a feed, hand the baby over, and
your wife stops it from her phone. Either of you can correct the sides before
it's saved.

This kills the obvious implementation — a timer living in the phone's local
storage — because a second device can't see it. **An in-progress feed is just an
`Event` with `ended_at = null`**, created on the *first tap*, not on Save. No new
table, no new concept: the data model already allows it, and every existing
endpoint (edit, soft-delete, the day timeline) works on it unchanged.

```
first tap of L or R   ->  POST /api/events/           creates it, ended_at null
each subsequent tap   ->  POST /api/events/{id}/timer/  {action, side, at}
Save                  ->  POST /api/events/{id}/finish/ sets ended_at
Discard               ->  DELETE /api/events/{id}/      soft delete
```

**The server owns the accumulators.** Clients send *intents* ("started L at
14:03:12"), never computed totals. If both phones each computed `right_sec` from
their own view and PATCHed it, the second write would silently clobber the
first — and with two people passing a baby back and forth, that is the normal
case, not an edge case. The payload therefore carries the live state:

```
right_sec, left_sec     accumulated, server-computed
running_side  L | R | null    null = paused
running_since <ts> | null     when the current side started
```

Elapsed time for the running side is `now - running_since`, so every device
renders a correct ticking clock without any of them agreeing on a clock.

##### Live updates: poll, don't socket

`GET /api/events/active/` returns the household's in-progress events. Clients
poll it **every 3s while a timer is running**, plus once on app foreground, and
not at all otherwise.

**Skipped:** WebSockets, Django Channels, ASGI, Redis. Live-updating a single
row for two people does not justify a second protocol and a broker on a
512MB machine. A 3-second poll that only runs during a feed is a few dozen
requests per feed.
<!-- ponytail: 3s polling; move to SSE if you ever have enough users that the
     request volume shows up on a graph -->

##### What this costs

- **A feed reaches the server before it's finished.** Offline, the app falls back
  to a local timer and reconciles on reconnect — you lose only the *shared* part
  while offline, not the timer.
- **Abandoned timers are real.** A tap that never gets saved leaves an event with
  `ended_at = null` forever. The app should surface anything running longer than
  ~3h as "still nursing?" and offer to finish or discard it.

`last_side` is one string and is the thing nursing parents actually want to know
at 3am. Not in Huckleberry's export; add it anyway.

**Local fallback still matters.** Persist `{running_side, running_since,
right_sec, left_sec}` to AsyncStorage on every tap so a dead battery or a killed
app loses nothing — but the server copy is authoritative whenever it's reachable.

#### Bottle / Diaper / Pump — instant, no timer
Timestamp **defaults to now**, with a small tappable time chip to back it up
when you're logging late. No pickers in the fast path.

- **Bottle** — number pad for volume, contents defaulting to `Breast Milk`
  (11 of 11 in your export).
- **Diaper** — pee/poo toggles + size, then optional colour and consistency.
  Two taps to save; 92 of 96 of your rows carry no notes.
- **Pump** — two volume fields, one per side, and a total.

#### Sleep — both entry paths *(when you start tracking it)*
- **"Asleep now" / "Awake now"** buttons — two timestamps at two moments, no
  visible running timer.
- **Two time pickers** for backfill, because sleep is the type most often logged
  after the fact.

### Home screen

Last-event summary on top, log buttons under it, today's timeline below:

```
┌─────────────────────────┐
│  <baby name>  ▾         │   baby switcher (hidden if only one)
├─────────────────────────┤
│ Last feed   2h 14m ago  │   the "when did he last eat" answer,
│   21m · R 13 · L 8      │   above the fold, no tapping
│ Last diaper    47m ago  │
│ Last pump    3h 02m ago │
├─────────────────────────┤
│ [ NURSE  ]  [ BOTTLE ]  │   2x2 grid, colour-coded per type
│ [ DIAPER ]  [ PUMP   ]  │
├─────────────────────────┤
│ ▸ today's timeline...   │
└─────────────────────────┘
```

Times are relative ("2h 14m ago"), not clock times — that's the number you
actually want half-asleep. A running nurse timer replaces the summary block with
the live in-progress banner.

### Copy: four review views, not two

Huckleberry ships **Day, Week, List, Summary**. That maps cleanly onto the
phases here — Day + List in Phase 2, Week in Phase 3, Summary in Phase 5.

**Change:** drop the month grid. Huckleberry's primary cross-day view is the
**week**, and for a newborn at ~22 events/day a month grid is unreadable anyway.
Week strip in Phase 3; revisit month at 6+ months old, if ever.

### Configurable = babies and users, not widgets

Household settings: add/edit/remove **babies**, invite/remove **users**. That's
it. I over-read this earlier as a customizable home screen — it isn't.

**One baby today: Henry.** But build the real setup flow in Phase 2 — add a baby
(name, date of birth, colour), edit it, and a baby switcher in the header that
hides itself when there's only one. A second baby then costs nothing, and the
"which baby is this" bug never gets a chance to exist.

**Skipped:** widget framework, drag-and-drop home layout, per-user layouts,
per-household enabled-type lists. Two adults and one baby need a settings screen
with two lists on it.

### Theme — light and soft

Warm off-white ground, no pure white and no pure black, rounded cards, generous
whitespace.

```js
// theme.js — one file, everything reads from it
bg        #FDFBF9   warm off-white
surface   #FFFFFF   cards
border    #EFE8E2
text      #3A3532   warm near-black, never #000
muted     #8C837C
accent    #E8877D   coral — primary actions

//  type      fill (blocks, buttons)   ink (dots, strokes, labels)
    nurse     #F2B7C4  pink            #9C3E5B
    bottle    #FCE9C1  cream           #897230
    diaper    #9CB981  sage            #225D00
    sleep     #79A2D8  blue            #004DA1
    pump      #D8D3FF  periwinkle      #6361A7
    other     #CFC6BE  warm grey       #6A5D50
```

**Every type has two values, and they are not interchangeable.** The pastel
`fill` is for large areas — timeline blocks, log buttons. The `ink` is for
anything small — the dots that mark instant events (bottle, diaper, pump) on the
timeline, borders, and coloured text. A pastel dot on an off-white page is
invisible: `bottle` fill is 1.16:1 against `bg`, while its ink is 4.50:1.

#### These values were measured, not eyeballed

The first palette I wrote failed badly. It held all six colours at matched
lightness "so no one category shouts" — which leaves hue as the only channel,
and hue is exactly what colourblindness removes. `pump` and `sleep` came out at
**ΔE2000 = 2.1** under deuteranopia: the same colour.

The fix is a deliberate **lightness spread**, because lightness survives every
form of CVD and grayscale printing:

```
sleep 66  <  diaper 72  <  nurse 80  <  pump 86  <  bottle 93     (L*)
```

Measured with CIEDE2000 against Machado et al. (2009) CVD simulation:

| | normal | deuteranopia | protanopia | tritanopia |
|---|---|---|---|---|
| **fills**, min pairwise ΔE | 18.4 | 13.9 | **13.6** | 14.1 |
| **inks**, min pairwise ΔE | 13.3 | 10.2 | **8.3** | 10.2 |

Above ~10 is comfortably distinguishable; the fills clear it in every mode. The
inks' worst case is `sleep`/`pump` at 8.3, acceptable only because those dots
always carry an icon and a label too.

Dark text `#3A3532` clears 4.5:1 on every fill (weakest: `sleep`, 4.59:1). Every
ink clears 4.5:1 on `bg` (weakest: `bottle`, 4.50:1).

**Colour is never the only signal** — every event has an icon and a label.

**If you change one colour, re-run the check** rather than eyeballing it; the
script is `palette-check.py`. Six pastels that look distinct on a desktop
monitor routinely collapse under CVD, in sunlight, and at dot size.

**Skipped:** dark mode. Add it the first time the 3am nurse screen blinds you —
which is a real possibility, so keeping tokens in one file makes it a
30-minute change rather than a refactor.

### Do NOT copy

- **The onboarding questionnaire.** Reviewers call it long and cumbersome. You
  have two users and you already know the baby's birthday.
- **Home-screen density.** The most common UI criticism is that the default view
  is overwhelming. Start with your three real types; add as you need them.
- **AI assistant, community, articles, sleep plans.** That's their subscription
  business, not your tracking app.

---

## Phases

Each phase ends with something usable on your phone.

### Phase 1 — Server + your real data  ✅ **built**
Django project, the models above, DRF endpoints (`/events` with `baby` +
local-date-range filters, `/babies`, `/households`, token auth), deployed to Fly
with Postgres.

Then the importer, as a management command. **The export format is decoded** —
see below, derived from a real 224-row export (2026-08-17 → 2026-08-27).

**The real export is not in this repo**, and `.gitignore` blocks `*-export.csv`.
It's health data about a real child; it does not belong in version control, even
a private one. Tests and the parser self-check run against a synthetic 13-row
fixture in `server/events/testdata/` built to hit every parser branch. Import
your own file by path once you have an account in dev or prod.

**Status:** built, tested and **deployed** — https://babylog-app.fly.dev.
18 tests green against the synthetic fixture; SQLite on a Fly volume with WAL +
IMMEDIATE verified in production.

**The real import waits for the UI.** Nothing is loaded into prod yet, on
purpose: the whole point of the preview/commit split is reviewing 224 rows with
checkboxes and warnings, and a CLI import would bypass exactly the step that was
asked for. Import once Phase 2 ships the review screen.

#### The export format, decoded

Huckleberry exports 8 generic columns and **reuses them with a different meaning
per type**. There is no honest column-to-field mapping; the importer needs a
parser per type. Verified against all 224 rows:

| Type | n | `End` | `Duration` | `Start Condition` | `Start Location` | `End Condition` |
|---|---|---|---|---|---|---|
| **Feed** (breast) | 98 | end ts | wall-clock, always == End−Start | **right-side** time `00:13R` | `Breast` | **left-side** time `00:08L` |
| **Feed** (bottle) | 11 | *empty* | — | contents, always `Breast Milk` | `Bottle` | volume, `3.5oz` |
| **Diaper** | 96 | — | **poo colour** `yellow`/`brown`/`green` | consistency `Runny`/`Loose` | — | contents `Both, pee:medium poo:large` |
| **Pump** | 19 | 2 rows only | 2 rows only | volume `2oz` | — | volume `1.5oz` |

Gotchas the parser must handle, each confirmed in the data:

- `Duration` holds a **colour** for diapers. It is not a duration.
- Breast sides are always `R` in `Start Condition`, `L` in `End Condition`.
  Either may be blank — that's a single-side feed, not missing data. All 98 have
  both an End timestamp and a Duration; 0 mismatches against wall-clock.
- Bottle feeds are **instant** — no End on any of the 11. Don't synthesise one.
- Diaper contents parse from a small grammar: `Pee:size`, `Poo:size`, or
  `Both, pee:size poo:size`. 13 distinct strings, all covered.
- Pump carries **two** volumes, and both are real. `Start Condition` on all 19
  rows, `End Condition` on 16 of them. They vary independently (`2oz`/`1.5oz`,
  `0.5oz`/`2.5oz`, `0oz`/`2oz`), are equal in only 4 of 16 rows, and sum to
  20.25oz vs 21.75oz — 42oz total. Import **both**; treating `Start Condition` as
  "the volume pumped" would silently discard half the record.
  The export never labels which side is which, so store both and **always display
  and aggregate the total**, which is correct under every interpretation. If the
  sides turn out to be swapped it's a JSONB key rename, not a migration.
- 4 diaper rows have free-text Notes. Preserve verbatim.

`Duration` is fully redundant for breast feeds (0/98 disagree with End−Start) —
dropped on import, always derived.

**Units: metric is canonical, imperial is a display preference.** See below.

**Status: the parser is written** — `import_huckleberry.py`, no Django import, so
it runs today. `python3 import_huckleberry.py` self-checks against all 224 rows.
Two things it caught that the eye would not have:

- **Two diapers logged in the same minute** (2026-08-24 10:55, one pee one poo).
  Both real. Event ids therefore hash the *whole* row plus an occurrence ordinal,
  not `Start`+`End`, which collided on them.
- **The duration columns are `HH:MM`, not `MM:SS`.** `00:21` is 21 minutes.
  Reading them as MM:SS silently divides every nursing time by 60.

#### Import is reviewed row by row before it commits

Nothing lands in the database from a file without you seeing it first.

```
POST /api/import/preview/   multipart file  ->  224 parsed rows, SAVES NOTHING
        ↓  app renders them as an editable, checkable list
POST /api/import/commit/    {baby, events}  ->  saves the rows you sent
```

**The review screen:**

```
┌──────────────────────────────────────────────┐
│  Import · 224 rows · 3 with warnings         │
│  Baby: [ Henry ▾ ]      Zone: [ New York ▾ ] │
│  ☑ Select all            221 of 224 selected │
├──────────────────────────────────────────────┤
│ ☑  Aug 17  3:13pm  nurse   64m  R 36 · L 27  │
│ ☑  Aug 17  6:00pm  diaper  pee medium        │
│ ☐  Aug 17  8:04pm  diaper                  ⚠ │
│      diaper needs at least one of pee/poo    │
│ ☑  Aug 19 10:00pm  pump    22ml              │
│      ⓘ already imported — will update        │
├──────────────────────────────────────────────┤
│            [ Import 221 rows ]               │
└──────────────────────────────────────────────┘
```

- **A checkbox per row, all checked by default**, plus select-all / deselect-all.
- **Rows with problems show a red warning** and the reason, inline. They stay
  checked — you decide whether to fix, skip, or import anyway.
- Any field is editable before committing.
- `already_imported` marks rows you've imported before, so a second run shows
  what's new instead of looking like 224 duplicates.

**Commit is per-row, not all-or-nothing.** The client sends only the checked
rows; the server re-validates each one (never trusting what comes back), saves
what passes, and reports what it skipped by index with reasons. A skipped row can
be fixed and re-sent on its own. The saved rows go in one transaction so a
database error can't half-write them.

That partial-success response is what makes per-row safe: you always know exactly
what landed, and re-previewing shows the true state.

**No staging table.** The parse is deterministic and cheap, so the client holds
the draft and re-uploading is the recovery path.
<!-- ponytail: draft lives in client memory; add a staging table if you ever
     import something big enough that re-uploading is painful -->

Ids are derived from row content, so **both paths are idempotent** — the CLI
command and the API commit can run twice with no duplicates.

### Phase 2 — Log + day view  🚧 **in progress**
Expo app. Auth screen, baby switcher, the logging forms for the types you
actually use — **feed, diaper, pump** — and the **day timeline**. Ship to
TestFlight and to the web build.

Logging and reviewing the day ship together, because they're the two halves of
one loop: you log at 3am and read the day back at 9am. A list with no timeline
doesn't answer "when did he last eat, and how long has he been up."

**A separate screen per type** (see "Logging is bespoke per type"): nurse is the
L/R timer and the single most-used control in the app — 98 of your 109 feeds;
bottle and pump are number pads; diaper is toggles. Everything except nurse
defaults its timestamp to now. If logging is slower than Huckleberry, neither
of you will use it and nothing after this phase matters.

**The day timeline:** 24h vertical axis, interval events (breast feeds) as
blocks, instant events (diaper, bottle, pump) as dots on the axis. Sleep blocks
slot in later with no new code. Hand-rolled, ~100 lines of absolute
positioning — no library does this view well. Header shows the day's rollup:
feeds, total minutes, diaper counts, oz pumped.

Also in Phase 2, because both depend on the API being live:
- **The shared nurse timer** (see above) — server-owned accumulators, 3s polling,
  the abandoned-timer nudge.
- **The import review screen** — checkbox per row, red warnings, select-all.
  This is what unblocks loading your real history.

**Built so far:** Expo Router app (iOS + web from one codebase), token auth with
the token in the keychain on device, home screen with last-event summary and the
2x2 log buttons, the shared L/R nurse timer end to end, bottle / diaper / pump
forms, and the 24h day timeline. Server side: `active/`, `timer/`, `finish/`
with 27 tests.

**Also built:** the import review screen, tap-to-edit, and the **settings screen**
— household name, units, home timezone, and add/edit/archive babies with a date
of birth and colour.

**Backdating is complete.** The instant forms and the event editor keep the quick
−5/−15/−30m chips as the fast path and add an "another day" toggle with a real
date and time picker — the browser's own inputs on web, the platform picker on
iOS. Future times are clamped, since an event cannot have happened yet.

**Email invites are built**, so a second parent no longer needs the Django admin.
Settings → Invite someone takes an email address and sends a link; the recipient
opens `/join?code=…`, picks a username and password, and is in. Nobody copies a
code by hand.

`POST /api/auth/register/` is the **only unauthenticated write in the API**, so
it is the most defended thing here:

- **the link creates exactly one account and then stops working** — `accepted_at`
  is set on use, re-checked under `select_for_update` inside the transaction so
  two simultaneous redemptions cannot both win, and a DB check constraint keeps
  `accepted_at`/`accepted_by` in step so "already used" can never drift
- the code is 24 random bytes and expires after a week
- missing, used and expired codes return the **same** message, so probing cannot
  tell a real code from a fake one
- passwords go through Django's validators, not a length check
- usernames collide case-insensitively
- a rejected registration never consumes the invite
- throttled to 20/hour per anonymous client — loose enough that two parents
  behind one home IP fumbling a password are not locked out, which 10/hour was
  not
- the raw code is never returned on its own, only inside the link

**Email is plain Django SMTP configured by environment variables**, defaulting to
Gmail. No dependency, no provider lock-in: any SMTP host works by overriding
`EMAIL_HOST`. With no host set, mail is printed to the log rather than silently
dropped. A send failure never loses the invite — the response says
`email_sent: false` and the UI offers the link to pass on by hand.

**A running feed is editable before it is saved.** The nurse screen shows
"Started 3:14pm — tap to adjust" and opens a date/time field; notes are editable
too. Both work whether the timer is running or paused, because the side
accumulators are independent of `started_at`.

The server enforces the invariant that makes this safe: **nursing sides can never
add up to more time than the feed itself lasted.** That was reachable two ways
before — dragging the start time forward on a running timer, and typing minutes
by hand in the event editor, which had no check at all. Both are now 400s.

**Opening the nurse screen never forks a second feed.** The screen mounts its own
poll, so for a moment it cannot tell "no timer is running" from "I have not asked
yet" — and tapping a side in that window used to create a *second* in-progress
feed. Two fixes, because either alone leaves a hole:

- the client distinguishes the two states (`loaded`) and disables the side
  buttons while it is still checking
- the server refuses to fork: starting a feed for a baby who already has one
  running returns **the running feed** instead of a new one, so a second device
  joins it. That also covers both parents tapping Nurse at the same moment,
  which no amount of client-side care can prevent.

**Still to build:** the abandoned-timer nudge.

**A safeguard added with settings:** `Event.baby` cascades, so deleting a baby
would have silently taken every feed, diaper and sleep with it. Deletion is now
refused for any baby with history — the UI offers **Archive**, which hides them
and keeps the record.

**Done when:** both phones have it, your real Huckleberry history is imported
through the review screen, you log a real day on it, and you'd rather open it
than Huckleberry.

### Phase 3 — Calendar navigation + edit  🚧 **mostly built**
Move between days and see patterns across them:
- **Week strip** above the timeline — tap to jump, density per day. **Built**,
  with prev/next arrows and a Today/Yesterday label.
- **List view** — reverse-chron for the selected day. **Built**, toggled from
  the day header; shares the timeline's query.
- **Every event on the calendar is tappable, and opens editable.** Day timeline,
  week strip and list all route to the same editor; it reuses the Phase 2 forms
  in edit mode rather than a second set of screens. Delete is a soft delete, so
  it syncs to the other phone rather than silently reappearing.
  **Built.** Tapping any block or list row opens `event/[id]`; a running timer
  routes to the nurse screen instead.
- **Backdated entry** — logging a feed you forgot two hours ago. Partly built:
  the instant forms offer −5/−15/−30m and the editor offers ±5/15/60m. A real
  date/time picker is still missing, so you cannot yet log against a past *day*.

**Timezone correctness landed here.** Events are placed on the axis by
`hourOffset(started_at, event.tz)` — each event's own recorded zone, not the
viewer's — and days are bounded with `Intl`, so DST days come out 23h and 25h
instead of a naive 24. `src/days.test.mjs` covers spring-forward, fall-back, a
Lisbon-vs-New-York night, and leap year.

**Still open in this phase:** a date picker for backdating beyond today, and
month navigation beyond the 7-day strip.

This completes the "record / edit / add" requirement.

### Phase 4 — Sync hardening  ✅ **built (rescoped)**

**Rescoped from the original plan.** That version assumed a local-first client
with a full sync engine. The nurse timer then went server-authoritative, because
both phones must see it — which removed the hardest part of the problem. What was
actually needed is much smaller:

- **`src/cache.js`** — every read falls back to the last good response, so the
  app renders on a dead connection. Screens are told the data is `stale` so they
  can say so rather than quietly lying.
- **`src/outbox.js`** — writes that can wait (instant events, edits, deletes) are
  queued in AsyncStorage and flushed on next load. Client-generated UUIDs mean a
  double flush upserts instead of duplicating.
- **`src/OfflineBar.js`** — "N changes waiting to sync", tappable to retry.
  Silence would let you believe a feed was saved when it is sitting in a queue.

**Only a lost connection is queued.** A 4xx means the server looked at the
request and refused it; retrying forever would never succeed *and* would wedge
every later write behind it. Those are dropped and counted. Tested in
`src/outbox.test.mjs`: offline preserves order, reconnect drains, a rejected row
is dropped without blocking the rest, and a mid-flush disconnect keeps the
remainder queued in order.

**Offline nursing is built**, and it turned out to be two cases, not one:

1. **A feed is already running on the server and the connection drops.** Timer
   intents carry their own `at`, so they queue and replay in order and the server
   still computes the right totals — a queued `finish` uses the moment you tapped,
   not the moment it flushed. The screen shadows the arithmetic locally just to
   keep ticking.
2. **No feed exists and one cannot be created.** The timer runs purely on the
   device (`src/localTimer.js`, same accumulator rules as the server, persisted on
   every tap so a dead battery loses nothing) and is queued as one complete event
   on Save.

A feed that goes local **stays local until saved**, even if the connection returns
mid-feed. Promoting it halfway would mean reconciling against a partner who may
have been tapping too. The cost: a feed started offline is not shared live.

**Bugs this surfaced**, all found by review after the feature "worked":

- `Event.id` is `editable=False`, so DRF silently marked it read-only and
  *discarded* client-supplied ids. Every claim about the outbox being idempotent
  was false — a double flush would have duplicated.
- Making `id` writable then made it writable on **update** too, where a changed
  pk makes Django UPDATE nothing and INSERT a copy. A `PATCH` carrying a
  different id returned 200 and silently left two rows. `id` is now accepted only
  at creation.
- A malformed `id` hit the queryset before any serializer and escaped as a **500**.
- A queued "start a timer" write flushing *after* that timer was finished tripped
  the `in_progress_events_have_no_end` constraint — another 500. It is now a no-op,
  like the deleted case.
- The offline bootstrap routed through the outbox, which **queues** rather than
  throwing. One offline tap therefore enqueued an `in_progress` event nothing
  would ever finish *and* fell through to a local timer — a duplicate feed plus a
  phantom one running forever. Bootstrapping now uses a direct write that fails
  loudly.
- The tap that *discovered* the outage was applied locally but never queued, so
  the server banked the whole stretch to whichever side was running when the
  connection died. The screen and the saved feed disagreed.
- `save()` had no offline path unless a tap had already failed, so losing the
  connection and then pressing Save left the feed in progress on the server.
- Server clock skew was being added to a device-clock timer, making an offline
  timer start at zero or jump by the drift.

**Skipped:** CRDTs, a sync engine, NetInfo. Offline is inferred from request
failure, which is the only thing that actually matters — can I reach the API.

### Phase 5 — Insights  ✅ **built**

`app/insights.js`, over 7 / 14 / 30 days. All aggregation is client-side in
`src/stats.js` — a week is a few hundred rows, and a server endpoint would be a
second place for the same arithmetic to be wrong.

**Stat tiles** (a single headline number is not a chart): feeds/day, typical gap,
nursing/day, diapers/day, night-feed share, pumped total.
**Bar charts**, one series each: feeds, nursing minutes, diapers, pumped.

Decisions worth keeping:
- **Median, not mean, for the feed gap.** One four-hour overnight stretch drags an
  average away from what the days actually look like.
- **Intervals are start-to-start**, which is what "how often is he eating" means,
  and they span midnight rather than resetting each day.
- **Averages divide by days *with data*.** Otherwise importing an 11-day history
  and viewing 30 days would silently show a third of the real rate.
- **Day buckets use each event's own `tz`**, so a travel day is not smeared.
- Charts are single-series, so **no legend and no cycled hues** — the title names
  the series, the colour is the event type's own, already CVD-validated. Values
  are labelled selectively (peak only), text uses text tokens rather than the
  series colour, and the baseline is recessive.

Validated against the real 224-row export: bucketed feed and diaper totals match
the raw counts exactly, and interval count is n−1.

### Phase 6 — Predictions *(parked)*
"Due for a nap in ~40 min."

**Parked — you aren't recording sleep yet, and that's fine.** There are zero `Sleep` rows in the export —
you are tracking feed, diaper and pump, and nothing else. Huckleberry's headline
prediction feature runs on sleep history, so this phase cannot start until Phase
2 has been shipping sleep logs for a few weeks.

Two consequences worth acting on now:
- Ship sleep logging in Phase 2 anyway, even though it imports nothing. It is
  the input to everything in Phases 6 and 7.
- The feed data you *do* have supports a real prediction today — next feed due,
  from rolling median inter-feed interval. 109 rows over 10 days is thin but not
  nothing, and it's the same machinery. Do that one first.

When sleep data exists: rolling median wake window from that baby's own last N
days, bucketed by age. Ship the boring version, measure it against reality for
two weeks, and only then consider anything smarter.

### Phase 7 — Reminders
`expo-notifications`, **locally scheduled** off the Phase 6 prediction. No push
server, no FCM, no APNs certificates. Add real push only when you need to notify
*the other parent* about *your* action — which is a different feature.

---

### Phase 8 — iOS widgets and Live Activities

Two widgets, both about not opening the app:

- **Last event** — "Last feed 2h 14m ago · 21m · R 13 · L 8", plus last diaper and
  last pump. The home screen's summary block, on the home screen proper.
- **Running timer** — while a nurse timer is going, show it counting, with
  **L / R / Save** buttons right on the widget.

#### What this actually requires

Widgets are **not React Native**. They are a separate WidgetKit extension target
written in SwiftUI, so this is real native work, not a library install.

- **Not possible in Expo Go** — needs a custom native build. Already fine: the
  EAS Build + TestFlight path is the plan (see Decisions).
- `expo-apple-targets` adds the extension target to the Expo project without
  ejecting to bare.
- **App Group** shared container (`group.<bundle-id>.babylog`) is how the RN app
  and the widget exchange data. The app writes the last-event summary and any
  running-timer state; the widget only ever reads local state — widgets can't
  reliably do network calls.

#### The two things that trip people up

**A widget cannot tick every second via timeline reloads.** WidgetKit budgets
roughly 15–40 refreshes per day, so a per-second reload is impossible. The
mechanism that *does* work is SwiftUI rendering a self-updating clock:
`Text(startDate, style: .timer)` for the running side and
`Text(lastFeed, style: .relative)` for "2h 14m ago". Both update on their own
with **zero** timeline reloads. Reload the timeline only when the underlying
event changes, via `WidgetCenter.shared.reloadAllTimelines()`.

**Buttons on a widget need App Intents** (iOS 17+). That's what makes L / R /
Save tappable without opening the app. The intent calls the same
`/events/{id}/timer/` endpoint the app uses.

#### Live Activities are the better fit for a running feed

An in-progress nursing session is exactly what ActivityKit is for: lock screen
and Dynamic Island, live, with the same interactive buttons. At 3am you see it
without unlocking. Build the Live Activity **before** the home-screen timer
widget — same SwiftUI views, and it's where you'd actually look.

#### The honest limitation

A widget shows *last known* state. When your wife starts a feed on her phone,
your widget won't know until your app syncs. Closing that gap needs a **push
notification to trigger the reload** — which means real APNs, and is the point at
which Phase 7's local-only notifications stop being enough.

That's a fair trade to defer: the widget is still correct for whoever started the
timer, and the Live Activity is live on the device that owns the session.

**Skipped until asked:** Android widgets, Apple Watch, complications.

---

## Settled

- **Units: metric canonical**, imperial is a client-side display preference.
- **Imports are previewed, editable and checkable per row**; commit is
  per-row with a partial-success report, not all-or-nothing.
- **One baby, Henry.** Full baby setup UI built anyway; switcher hides at n=1.
- **Theme: light and soft.** Warm off-white, coral accent, and a fill/ink pair
  per type — CVD-verified, min ΔE 13.6 on fills across all colourblindness types.
- **Two logins**, one each. `Membership` and `created_by` stay — worth knowing
  who logged what at 3am.
- **SQLite on a Fly volume**, WAL + IMMEDIATE, one machine. Postgres remains a
  `DATABASE_URL` change away.
- **Timezone travel: yes.** UTC + recording zone; see above.
- **CSV decoded**; the real export stays out of the repo, tests use a
  synthetic fixture.
- **Pump stores both volumes**, displays the total. Side labels provisional.
- **Sleep/predictions parked** until you're recording sleep. Sleep logging still
  ships in Phase 2 so the data starts accumulating.
- **Day view is core, not later.** Merged into Phase 2 alongside logging.
- **Month grid dropped.** Huckleberry's cross-day view is the week; a month grid
  is unreadable at 22 events/day. Week strip + list view instead.
- **Logging is bespoke per type.** No generic form. **Nurse is the only timer** —
  two mutually-exclusive accumulating sides, then Save. Everything else is
  instant with the timestamp defaulting to now.
- **Configurable = babies and users.** A settings screen with two lists, not a
  widget system.
- **Sleep gets both** live buttons and backfill pickers, when it starts.
- **Timers are shared and live across devices.** An in-progress feed is an
  `Event` with `ended_at = null`, created on first tap; the server owns the
  accumulators; clients poll every 3s while one is running.
- **Home screen** = last-event summary (relative times) → 2x2 log buttons →
  today's timeline.
- **Phase 4 rescoped**: cache + write outbox, no sync engine. Offline nursing
  still to do.
- **Insights are client-side**, median-based, and only average over days that
  have data.
- **iOS widgets + Live Activities** are Phase 8 — native WidgetKit work, App
  Group for data, `Text(style: .timer)` for ticking, App Intents for buttons.

## Open questions

1. **Pump sides.** Only affects per-side labels. Totals are right regardless —
   not worth blocking on.
2. **Does the pump belong to a person?** Household event today; `created_by`
   already records who logged it if that turns out to be enough.
