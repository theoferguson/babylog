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
note      {label}                        # free-form: the title on the calendar
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

#### Sleep — shipped
- **A timer**, not two buttons: "Fell asleep" starts a server-side `in_progress`
  sleep, "Woke up" calls the same generic `finish` a feed uses. It is on the
  server rather than the phone so one parent can start it and the other stop it,
  the same reason a feed is. No sides, nothing to bank between taps, so none of
  nurse.js's timer-intent machinery is needed — which is why `/sleep` is 100
  lines and `/nurse` is 400.
- **No offline shadow timer** yet, unlike nursing. Marked in the code.
- Backfill is the editor: the timeline start and end are both editable after the
  fact, which is what the two time pickers were for.

#### Something else — shipped
The sixth button. A `note` event whose `payload.label` is a title — a
medication, an appointment, "first smile" — shown as the event's name wherever
an event is listed. `titleFor()` is what puts it there: a free-form event is its
title, everything else is its type. Voice can title one too ("gave vitamin D").

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
│ [ NURSE  ]  [ BOTTLE ]  │   2x3 grid, colour-coded per type,
│ [ DIAPER ]🎤[ PUMP   ]  │   mic in the gap at the dead centre
│ [ SLEEP  ]  [ OTHER  ]  │
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

### Phase 2 — Log + day view  ✅ **built**
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

**A nursing feed's duration is time the timer actually ran** — the two sides
added up, across however many stretches — everywhere it appears: the headline
clock, the calendar label, and the nursing-minutes charts in Insights. It is
*not* start-to-end: a feed can be paused and picked up again, and the paused
stretch is not nursing time. Bottle feeds and sleep still use wall clock, since
for those the two are the same thing.

**The calendar shows the difference rather than hiding it.** A paused feed is
drawn faded across its whole span with the stretches it was actually nursing
picked out solid, so a 19-minute feed spread over 105 minutes reads as exactly
that. This needs `payload.segments` — `[{side, from, to}]`, appended whenever a
side is banked — because per-side totals alone cannot say *when*.

**Stretches are dropped the moment they stop being true.** Editing the side
totals by hand makes them describe a run that did not happen, so the server
removes them on any update that changes `right_sec` or `left_sec`. The client
independently ignores stretches whose lengths do not add up to the side totals,
which is what stops already-saved bad data drawing a shape that contradicts its
own duration. The offline timer records stretches too, so a feed logged with no
connection draws identically to one logged with one. **A block is only as tall as the time it represents.** A nursing feed occupies
its nursing time on the axis, not the span it happened to cover — 19 minutes of
nursing spread over 105 reads as 19. The exception is a feed that recorded
segments: there the real span is drawn faded with the nursing stretches picked
out inside it, because then there is something worth seeing. Everything imported
and every instant event has no segments and draws solid, which is right for them.

**What each timestamp is actually for**, since conflating them caused several
rounds of this:

- `started_at` — **where the feed sits on the calendar.** That is its whole job.
  It is the one a parent corrects, because "this began at 5:30, not 7:00" is a
  real thing to fix.
- `ended_at` — **when the nursing stopped.**
- `right_sec + left_sec` — **how long the feed was**, and the only thing that
  should ever be called its duration.

Sizing blocks by `ended_at - started_at` therefore made correcting a start time
look like lengthening the feed, which is backwards: moving the pin should move
the block, not stretch it.

**A feed spans the stretches the timer ran, and nothing else.** Opening the
screen and not tapping for seven minutes is not seven minutes of nursing, and
neither is the phone lying face-down for an hour before someone presses Save.
Both used to be stored and drawn — `started_at` was when the screen opened and
`ended_at` was when Save was tapped — so a 47-minute feed could occupy 154
minutes of calendar, faded at both ends. The invariant now is that
`started_at` is the first recorded stretch's start and `ended_at` is the last
one's end. `segment_span()` supplies the pair; `finish` writes it, and
`EventSerializer.validate` clamps both ends inwards so hand edits and imports
obey the same rule. A feed that never ran a timer has no stretches to clamp
to, so the screen's own instants stand.

**Correcting the start time moves the whole feed.** The stretches shift with
it, which is what keeps the invariant true — leave them behind and the feed
sprouts a gap at the front that was never anything. A still-running side is
shifted too, and *that* is what makes the correction land in the total: pushing
the start back ten minutes leaves the finished stretches the length they were
and adds ten minutes to whichever side is still counting. Done server-side, in
`EventSerializer.validate`, because the client must never compute accumulators
— and in `validate` rather than `update` so it runs before the clamp that
depends on it, next to the stale-segment drop that must run before them both.

**Which side is next is a corner badge, not a sentence.** The nurse screen
marks the side that was used last -- from this feed if one is running, else
from the last saved breast feed -- with a small `last` in the button's top
corner. It is fetched from a ten-event window rather than the single latest
feed, so a couple of bottles in between cannot hide it, and it disappears
while a side is counting, when it would only be restating the obvious.

**A running feed is editable before it is saved.** The nurse screen shows
"Started 3:14pm — tap to adjust" and opens a date/time field; notes are editable
too. Both work whether the timer is running or paused, because the side
accumulators are independent of `started_at`.

**Side times are edited freely.** Type whatever the two sides were; the feed
lasts that long and the screen says so. There is no coupling to the recorded end,
because there is nothing to couple to.

There was briefly a rule that nursing sides could not exceed `ended_at -
started_at`, and a client workaround that silently stretched the end to satisfy
it. Both are gone. The rule assumed the span was a real quantity — but
`started_at` only pins the feed on the calendar and `ended_at` is just when Save
was pressed, so their difference is not something the side times can contradict.
The guard remains for sleep and bottle feeds, where the span genuinely is the
duration. That was reachable two ways
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

### Phase 3 — Calendar navigation + edit  ✅ **built**
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
- ~~Ship sleep logging in Phase 2 anyway~~ — done. A timer on the home screen
  and a voice path. Whether it gets *used* is now the open question, and it is
  a habit question rather than a software one.
- The feed data you *do* have supports a real prediction today — next feed due,
  from rolling median inter-feed interval. 109 rows over 10 days is thin but not
  nothing, and it's the same machinery. Do that one first.

**Half of that third point has shipped, the easy half.** The next-feed banner
exists, but off a *fixed* interval the household picks, not a learned one. That
was the right first move — it is useful immediately, it needs no history, and
it built the surface the real prediction will render into. Swapping the
constant for a rolling median over that baby's own recent feeds is then a
change to one expression, with the banner, the settings row and the overdue
styling already in place. Do that before anything sleep-shaped: it is the
cheapest way to find out whether a predicted number is something you actually
act on, or just decoration.

When sleep data exists: rolling median wake window from that baby's own last N
days, bucketed by age. Ship the boring version, measure it against reality for
two weeks, and only then consider anything smarter.

### Phase 7 — Reminders *(blocked on Phase 6)*
`expo-notifications`, **locally scheduled** off the Phase 6 prediction. No push
server, no FCM, no APNs certificates. Add real push only when you need to notify
*the other parent* about *your* action — which is a different feature.

---

### Phase 9 — Natural-language logging  ✅ **part 1 built**

Dictate *"fed 20 minutes left side around 3, then a wet diaper"* and get
structured events **staged as draft cards on a review screen**. Nothing is
written until you tick the rows and press save — and the same voice that
created the draft can correct it and approve it.

**Why this one is worth building.** Not because it needs a model — because the
expensive half is already here. There is a typed schema, a per-type validator
that rejects unknown keys (`validate_payload`), invariants the server enforces
whatever the source (`segment_span`, the side-total/segment consistency rule),
and a parse → review → commit flow with per-row checkboxes and red warnings
(`import_preview` / `import_commit`, `app/import.js`, `src/ImportRow.js`). Most
LLM features have nothing to check the model against. This one has all of it
already, and the model gets to reuse it rather than route around it.

The guardrails are listed once, in *Part 1* below, next to the code that
implements them.

**The eval is the part that makes it a real project.** 225 imported events are
ground truth. Render each one back to natural language, feed it in, assert the
round-trip — event type, side, volume, and timestamp within a tolerance. That
gives an accuracy number that moves when the prompt changes, which is the thing
most LLM side-projects never build. Keep it as a marked-slow test so it does
not run on every `manage.py test`.

#### Part 1 — voice in, review, commit  ✅ **built and shipped**

Deliberately the smallest thing that has all three properties. No tiers, no
local model, no router, no eval harness. Those are below, and they are later.

**Shipped 2026-09-01**, on `gpt-5.6-luna`. What the build changed from this
plan, and why:

- **It grew a UI.** The plan reused the import review screen; the built version
  has its own mic and `app/review.js`, because a text box on the import screen
  is strictly worse than tapping the Nurse tile. The mic is the feature.
- **The ids needed the household in them.** Content-derived means two
  households both saying "wet diaper" mint the same uuid5, and `import_commit`
  writes with `update_conflicts=True` — an unguarded collision silently
  rewrites somebody else's event rather than erroring. Fixed at both ends: the
  household is in the parse key, and `import_commit` now refuses foreign ids
  the way `EventViewSet.create` always has. The CSV importer keys on content
  alone too and keeps doing so, because changing it would strand the 325 rows
  already imported under the old scheme — the commit-side guard is what makes
  that safe.
- **Three API shapes had to be read rather than recalled.** `Events.list()`
  returns the body, not `{data}`; `expo-speech-recognition` subscribes through
  a *hook*, not `addSpeechRecognitionListener`; and `requiresOnDeviceRecognition`
  fails unless `supportsOnDeviceRecognition()` says yes. All three shipped
  broken first and all three were silent — the lesson is in *What is actually
  left* below.

**Server — `POST /api/events/parse/`.** Takes `{text}`, returns exactly the
body `import_preview` already returns, so the client has nothing new to render:

```python
text = (request.data.get("text") or "").strip()
if not text:               raise ValidationError("nothing to parse")
if len(text) > MAX_UTTERANCE:  raise ValidationError("too long")   # a pasted novel is not a feed

hh = current_household(request)
rows = extract_events(text, tz=hh.timezone, now=timezone.now())    # the only model call
for r in rows:
    # Content-derived, like the CSV path's uuid5 -- NOT uuid4. A timed-out
    # request the server actually completed, or the same sentence dictated
    # twice, must upsert rather than duplicate.
    r["id"] = str(uuid5(NAMESPACE, f"{hh.id}|{text}|{i}"))
    r["already_imported"] = False
    r["needs_baby"] = r["type"] != Event.PUMP
    r["errors"] = row_errors(r)   # the SAME validator the CSV path uses
```

`extract_events` is **one OpenAI call with strict structured outputs** —
`openai` SDK, **Chat Completions with `response_format` `json_schema` and
`strict: true`**, schema defined as a Pydantic model. Strict mode constrains
tokens at decode time, so the shape is guaranteed rather than requested.

**Chat Completions specifically, not the Responses API** — and the reason is
the whole justification for starting here. Together, Fireworks, Groq,
OpenRouter, vLLM, SGLang and Ollama speak *Chat Completions*; `text.format` on
the Responses API is OpenAI-only. Building on the portable surface means the
tier-1 rung below is already written when it is wanted. Pick the proprietary
one and the seam being bought is not the one the plan is paying for. Claude is
the same function with a different adapter — see the tiering section.

The system prompt is the schema + unit preference + today's date in the
household zone. Put anything varying last so the prefix stays stable — that
costs nothing and is good practice regardless. Do **not** count on automatic
prefix caching: it needs a long prefix (~1024 tokens, more than this is likely
to be) and a warm recent window, and this prompt contains the current date, so
it changes daily anyway. If caching matters later, measure it rather than
assume it.

**No babies in the prompt for part 1.** Per-row attribution is not expressible
on the write path: `import_commit` takes one `baby` for the whole request
(`views.py:377`) and `app/import.js:75` passes the session's `babyId`. "Ada
took 4oz, Ben had a wet one" would silently put both on whoever is selected.
One baby today, so this costs nothing; adding it means a per-row baby on the
review screen *and* in commit, and that is a later change.

**Two strict-mode constraints that shape the schema, and they matter here:**

- **Optional means nullable, not absent.** Under `strict: true` every key must
  appear in `required`; an optional field is a union with `null`. So the model
  emits *every* payload key on *every* row, nulled where it does not apply, and
  those must be stripped before `validate_payload`. The reason is narrower than
  it looks: `validate_payload` already skips a key that is `None`
  (`serializers.py:65`), so a null on a type's *own* optional field is
  harmless. What breaks is the *cross-type* keys the flat schema forces —
  `pee: null` on a feed is an unknown key for `feed` and fails at
  `serializers.py:59`.
- **Strict schemas want to be flat, and the flat schema must be a whitelist.**
  A root-level union of per-type payloads fights the format, so it becomes one
  object with `type` as an enum and every field nullable. **List only the
  user-settable fields.** `PAYLOAD_FIELDS[FEED]` also contains `running_side`,
  `running_since` and `segments` — server-owned timer state, marked as such in
  the code — and `validate_payload` accepts them as valid feed keys. Mirror the
  full list into the schema and a model can author stretches nobody timed;
  because `import_commit` bypasses `EventSerializer.validate`, they would
  commit unclamped and the calendar would draw them. `segments` is only checked
  as `(list, False)`, so a malformed element is not caught at all and can 500 a
  later `PATCH` through `_shift_times`. The parse schema whitelists; it does
  not mirror.

Which sharpens the guardrail story rather than weakening it: **strict mode can
only guarantee the schema you can express, and the schema you can express is
looser than the one you actually have.** The server-side validator closes part
of that gap; the whitelist closes the part the validator cannot see, because a
server-owned field is indistinguishable from a legitimate one once it is in the
payload.

**The key is `OPENAI_API_KEY`, set as a Fly secret**, read from the environment
by a bare `OpenAI()`. Server-side only — never `EXPO_PUBLIC_*`, which is inlined
into the JS bundle and ships to every phone. The phone posts to
`/api/events/parse/` with the token auth it already has; the server holds the
key. That is also what makes "the model cannot write" true, since the only route
to a model is through the validated endpoint.

**Two operational limits this endpoint needs that no other one does**, because
it is the first route that spends money per request:

- **A per-user throttle.** `DEFAULT_THROTTLE_RATES` had one scope,
  `register: 20/hour`, and no default throttle class. Accounts are invite-gated
  — `RegisterSerializer` requires a usable code — so the exposure is a
  household member rather than a stranger, but a phone stuck in a retry loop
  spends just as fast as a malicious one. The utterance-length cap bounds a
  single call; `parse: 60/hour` bounds the loop.
- **Timeouts on both sides.** `api.js:44` hard-codes `timeoutMs = 15000` for
  every request, and an abort surfaces as `ApiError(0, 'Request timed out')`,
  which the app renders as being offline. A multi-event utterance can take
  longer than that: the phone would give up, show a connection error, and the
  server would finish and bill the call anyway. Pass an explicit longer timeout
  for this one call, and give the `OpenAI()` client a bounded one so a hung
  upstream cannot pin a worker — there are only 2x4 of them on a 512MB machine,
  and `useActiveEvents` is polling every 3s during a feed.

**The button.** A circle in the dead centre of the four log tiles — absolutely
positioned over the intersection of the 2x2 grid, ~64px, with a few pixels of
`c.bg` as a ring so it reads as floating above them rather than as a hole cut
in them. Subordinate on purpose: the four tiles keep their size and their
colours, and the mic is smaller than any of them. It costs the four inner
corners of the tiles, which are empty padding, and that is the whole price.

**The review screen — `app/review.js`.** One utterance can produce several
events ("fed 20 minutes then a wet diaper"), so this is a list of draft cards,
each with a checkbox, each editable in place, nothing written until a person
presses save. Same contract as the import review, different surface.

Per card: the type icon and label, the time, and then the same per-type fields
the event editor already draws. **Extract that block out of `app/event/[id].js`
into `src/EventFields.js`** — `(type, payload, setP, units, tint)` — and use it
in both. One component, two callers; the review screen inherits diaper sizes,
side minutes, bottle volume and pump volumes without a line of new UI, and a
future field is added once.

Rows that failed `row_errors()` show red and start unchecked, so the failure
mode is "you notice", not "it saved something wrong".

The CSV importer keeps its own screen. It is a different job — 200 rows from a
file, not two from a sentence — and merging them would make both worse.

**Correcting by voice, and the guardrail that makes it safe.** The mic is on
the review screen too: *"no, that was the right side"* re-posts to
`/api/events/parse/` with the current draft as context and gets a revised draft
back, validated identically. Spoken *"save it"* resolves to an approve intent.

The rule that keeps that honest: **one turn may revise or approve, never both.**
An utterance that does both — *"right side, and save it"* — revises and
re-presents, and waits for a second confirmation. Approve may only ever commit
the draft **exactly as it is already displayed**, which a human has already
looked at. The model recognises the command; it never authors the thing being
committed in the same breath as committing it.

**The four guardrails, and none of them are prompt instructions:**

1. **Schema-constrained generation.** A field that is not in the schema cannot
   be emitted, so there is no free-text JSON to repair.
2. **`row_errors()` re-validates server-side.** The model's output goes through
   the same check the CSV importer does. Nothing is trusted because of where it
   came from.
3. **`import_commit` stays the only write path.** The parse endpoint writes
   nothing at all — it returns a draft. Every existing check (payload shape,
   unknown-key rejection, baby-belongs-to-household, the timestamp invariants)
   applies at commit whatever produced the row.
4. **Time is resolved server-side and bounded.** `now` and the household zone
   go into the prompt; anything the model returns outside a sane window —
   future, or more than a few days back — becomes a row error rather than a
   quiet acceptance. A model must never be the thing that decides what "today"
   means.

Plus the input cap, which is a cost guardrail: an unbounded text field is an
unbounded bill.

**Human-in-the-loop is the whole shape**, not a confirmation dialog bolted on
the end. The rows land in a screen built for disbelieving them — every row
individually editable and deselectable, errors in red, nothing committed until
a person presses the button.

**The one check to leave behind.** Not a live eval — stub the model and assert
the guardrail: feed `extract_events` a response with a hallucinated field, a
swapped side, and a timestamp in 2031, and assert those rows come back with
`errors` populated and that nothing reached the database. Deterministic, free,
and it fails if someone later "simplifies" the validation away. A live
accuracy eval over the 225 imported events is worth building, but it belongs
with the tiering below, where a number that moves actually decides something.

**Cost:** roughly a few dollars a month at ~15 logs a day. `count_tokens`
before shipping if that matters; `effort` is the lever if it does.

**The mic is the feature, not a later enhancement.** Typing "fed 20 minutes
left side" is strictly worse than tapping the nurse tile — the tile is two taps
and cannot be misheard. The entire reason this phase exists is the case where
both hands are full and it is 3am, and that case is voice or it is nothing. So
the text field is a *fallback*: the accessible path, the quiet-room path, and
what happens when recognition fails. It is not a shipping milestone, and part 1
is not done without the microphone.

**Speech-to-text is on-device.** `expo-speech-recognition` wraps iOS
`SFSpeechRecognizer` and Android `SpeechRecognizer` as a TurboModule — free, no
second API, and the audio never leaves the phone, which matters more here than
usual because the sentences are about an infant's health. It needs
`NSSpeechRecognitionUsageDescription` and a microphone permission string in the
app config.

**It must be New-Architecture compatible, and the old ones are not.** babylog
runs Fabric. `@react-native-voice/voice` and its generation *fail silently*
under the New Architecture — no error, no transcript — which is exactly the
class of bug that reaches TestFlight because every web build passes.
`expo-speech-recognition` is a TurboModule, and that is the reason to pick it.

**The build cost is paid once, not per iteration.** The recogniser is a native
dependency, so this needs `eas build` rather than an OTA push — but only to get
the module onto the phone. Take a **development build** first; after that the JS
reloads over the wire as always, and the prompt, the review screen and the
parsing all iterate at normal speed. One production build and submit when it
works. That pipeline has already shipped to TestFlight twice, so it is one more
turn of a crank that already turns.

**Transcription error becomes the dominant failure mode**, ahead of extraction
error — "four ounces" and "for ounces" are one phoneme apart, and the recogniser
has no idea which one a bottle takes. That is an argument for the review screen,
not against the feature: it is what catches a misheard number before it becomes
a feed. It also means the eval, when it comes, has to be scored transcript-in
rather than text-in, or it measures the easier half.

**Explicitly not in part 1:** tiers, local or open-weight models, the router,
the eval harness, streaming. Ship this, use it for a fortnight, and let the
edits you actually make on the review screen say what tier 1 would need to be
good at.

#### Later — tiered routing by complexity and capability

*Not part 1. Build it when part 1 has been in daily use long enough to say
what the cheap tiers would have to handle.*

Not a shortlist with one winner: a ladder, where most utterances never reach a
frontier model and the ones that do have earned it.

The usual objection to a model cascade is that deciding *when* to escalate needs
a confidence score, and asking a model how confident it is measures nothing.
That objection does not apply here. **`validate_payload` is a deterministic,
free escalation trigger** — it answers "is this output actually well-formed"
without a second opinion, and the review screen is the backstop when it is
wrong. A cascade with an objective gate at every rung is a different animal
from one held together by self-reported confidence.

| Tier | Handles | Runs on | Schema enforcement |
|---|---|---|---|
| **0 — no model** | The phrasings you actually use: `diaper`, `wet`, `left 20`, `4oz bottle`, `pee + poo` | A dozen regexes, on-device | n/a — it is code, and code cannot hallucinate |
| **1 — small / local** | One event, plain phrasing, absolute or near-absolute time | Qwen3.6-27B class, vLLM or Ollama | XGrammar grammar-constrained decoding |
| **2 — frontier** | Multi-event utterances, relative and chained times, corrections, anything tier 1 failed | Whatever part 1 settled on, or `claude-opus-5` | Strict structured outputs, either way |

**Tier 0 earns its place first.** The ladder starts by asking whether this needs
a model at all, and for the top handful of phrasings it does not: a regex is
free, instant, offline, and cannot be wrong in an interesting way. Every
utterance it absorbs is one that never costs a token or a round trip. Build
this tier before either of the others — it is also the honest baseline the
model tiers have to beat in the eval.

**Routing is deterministic on the way in, and on the way out.**

*Pre-flight, before any model call* — cheap signals, no inference:
- token count of the utterance
- how many distinct event-type keywords appear (two or more → multi-event → tier 2)
- relative or chained time language: *after*, *before*, *then*, *again*, *earlier*
- correction language: *actually*, *no*, *instead* — these rewrite a previous row
  rather than adding one, which tier 1 reliably gets wrong

*Post-flight, deterministic escalation* — the tier below failed, objectively:
- `validate_payload` rejected the row
- schema-valid but impossible: end before start, a volume outside plausible range,
  a timestamp in tomorrow
- zero rows returned from a non-empty utterance
- the row count disagrees with the pre-flight keyword count

Never escalate on a model's own assessment of its work.

**Capability gates tier membership, which is the other half of "tiered".** A
model is only eligible for a tier if the transport can enforce that tier's
contract. Grammar-constrained decoding available → eligible for tier 1
unattended. JSON-mode-only or free text → it does not get a tier, because the
retry loop costs more than the tier above. And availability is part of
capability: the local box asleep, a provider 429, or no connection at all all
demote the ladder in the same direction.

**Which is where this meets the offline design already in the app.** With no
connection, tier 0 still works — it runs on the phone. Anything it cannot parse
queues the raw text through the existing outbox and is parsed when the
connection returns, staged for review then. The AI feature inherits the offline
story rather than needing one.

**What to measure changes: the eval now scores the router, not just models.**
Per tier — resolution rate (what fraction stopped here), accuracy at that tier,
and false-stop rate (resolved here, but the human then edited it). The last one
is the number that matters: a tier that resolves 80% and is quietly wrong on a
tenth of those is worse than one that escalates more.

**Human edits are the router's training signal, and they are free.** Every
correction on the review screen is a labelled example that the tier which
produced it got it wrong. Log the tier and the exact model id on every staged
row, and the edit rate per tier tells you where the thresholds are mis-set —
without anyone writing an annotation tool.

**Two honest costs of tiering**, neither fatal:
- Caches are model-scoped, so there is no cache reuse across tiers. But each
  tier has its own stable system prompt and its own cache, and tier 2 should be
  a minority of traffic, so the loss is small — not the argument against
  cascades it is in a chat product.
- Two model tiers is two prompt/schema pairs to keep in sync. Mitigate the same
  way as before: **one schema, one validator, one prompt body**, with only the
  transport and the enforcement mechanism differing. If a tier needs its own
  prompt to compete, it is not eligible for that tier.

#### Later — the seam underneath the tiers

`parse_events(utterance, ctx)` -> `list[dict]`, with the router above and two
adapters below it. No LangChain, no router library — the tier ladder is a
`for` loop over an ordered list, which is less code than the abstraction that
would wrap it.

- **Claude via the `anthropic` SDK.** Never through an OpenAI-compatible shim —
  structured outputs, adaptive thinking, prompt caching and `count_tokens` only
  exist on the real client.
- **Everything else via one OpenAI-compatible client** pointed at a `base_url`.
  Together, Fireworks, Groq, OpenRouter, vLLM, SGLang and Ollama all speak
  `/chat/completions`, so one adapter covers hosted and self-hosted alike.

**Constrained decoding guarantees the shape, not the meaning.** XGrammar — the
default backend in vLLM, SGLang and TensorRT-LLM — compiles the schema to a
state machine and masks any token that would leave a valid path, so tier 1
returns parseable JSON first pass with no retry loop. It will still happily
emit a schema-perfect feed with the sides swapped. That is why `validate_payload`
runs afterwards, why impossible-but-valid rows escalate rather than commit, and
why the human still ticks the boxes. The lowest model tier is the reason those
checks exist; the highest does not make them redundant.

**Rules that keep the ladder honest:**

- **Pin exact model ids**, and record the tier and model on every staged row.
- **Judge cost per completed task, not per request.** There is a human in this
  loop, so the real cost includes the correction at 3am. A tier that is a tenth
  the price and needs two edits per log is not cheaper — it is the expensive one.
- **Beat tier 0 or do not ship the tier.** A model tier that does not measurably
  improve on regexes for the traffic it claims is dead weight.

**The open-weight case here is privacy, not price.** This is an infant's health
record, and tier 1 is where nearly all of it would be parsed. A locally served
model means those utterances never leave hardware you own — a real reason to
keep that rung working even if a hosted model scores a point higher. Two honest
caveats: the Fly machine cannot host a 27B model (that needs a GPU box, so
"local" means a desktop, not production), and any hosted provider needs its
data-retention posture checked before a single feed goes through it.

**A starting pool, as of September 2026** — a snapshot, deliberately, because
this list ages in months and the eval is what actually picks:

- Part 1's own model at tier 2, with `claude-opus-5` the obvious thing to
  measure it against — the seam already accepts both.
- **Qwen3.6-27B** as the tier 1 candidate — dense, single consumer GPU, strong
  for its size. The privacy rung.
- **DeepSeek V4** as the cost-sensitive hosted alternative for tier 1,
  **Mistral Small 4** (119B total, ~6B active) as the lean option.

Note what this task actually is: short-utterance extraction into a small fixed
schema. That is not a frontier-reasoning problem, so tier 1 may well resolve the
large majority and tier 2 exist only for the messy 10%. Do not pick from
leaderboards — they measure GPQA and coding arenas, neither of which is "did it
get the left breast and the right time". Run the eval.

**What not to build here:** insight *narration* — a model handed a summary and
asked to write prose about it — has nothing to validate against and drifts
toward medical advice. That objection is about narration specifically, and
Phase 10 below is the design that answers it; an LLM
data-quality checker is a rules job — a four-hour nursing session is an `if`,
not a prompt. A second candidate worth keeping in the drawer: **LLM-proposed
import mappings**, where the model emits a column mapping for an arbitrary
baby-tracker CSV and the existing deterministic parser executes it, with the
parse-failure count shown before anything commits. Architecturally the stronger
story — the model emits config, code does the work — but less useful daily.

---

### Phase 10 — Agentic insights *(idea, not planned)*

**This is the one that should be an agent, and Phase 9 is the one that should
not.** Worth writing down because the difference is the whole lesson. Logging
has a known shape: text in, events out, one call, and the only "tool" an agent
would want there is a database write — exactly what the guardrails forbid.
Analysis has an *unknown* shape: which numbers answer "is he feeding more at
night lately?" is not knowable before asking, which is the actual case for a
loop.

**The tools are read-only by construction, and that is the guardrail.** A small
set of deterministic query functions over the household's own events —
`feeds_per_day`, `inter_feed_intervals`, `nursing_minutes_by_hour`,
`diaper_counts`, each scoped through the existing `Event.objects.for_user()`
tenancy boundary and each returning numbers, not prose. **No write tool
exists**, so the model cannot write whatever it decides to do. Same boundary as
Phase 9, enforced a different way: there the human holds the pen, here the tool
surface simply has no pen in it.

**Every claim shows the query that produced it.** This is the fix for the thing
that makes narration worthless. Render the answer with its tool calls and their
raw results underneath — "feeds ran ~18 minutes longer after 8pm this week"
sits directly above the numbers it came from, and a wrong claim is visibly
wrong instead of plausibly phrased. The tool call *is* the citation. That is
the validation narration cannot have, and it is why this design is worth
building where narration was not.

**The guardrail that is genuinely about safety, not correctness:** bounded to
describing *this baby's own recorded data*. No comparison to norms, centiles or
milestones, no "should", no interpretation of whether a number is a problem.
The app has no clinical basis for any of that and a confident sentence about an
infant's feeding is the kind of wrong that matters. Say what the data did; stop
there.

**Where it lives:** the Insights tab, which is already built and already
computes real aggregates (`src/stats.js`) — those functions are most of the
tool surface, so this reuses rather than adds.

**Costs to bound before building:** an agent loop is an unbounded bill, so cap
iterations and set a task budget; and cache nothing about the answers, because
the data changes every few hours and a stale insight is worse than none.

**Do not start this until Phase 9 has shipped.** Not sequencing for its own
sake: Phase 9 is where the tool-calling seam, the model config and the spend
guardrails get built, and this reuses all three. Built first, it would build
them worse.

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
- **Sleep/predictions parked** until you're recording sleep. Sleep logging has
  shipped — a timer, plus the voice path — so the data can start accumulating.
- **Day view is core, not later.** Merged into Phase 2 alongside logging.
- **Month grid dropped.** Huckleberry's cross-day view is the week; a month grid
  is unreadable at 22 events/day. Week strip + list view instead.
- **Logging is bespoke per type.** No generic form; the free-form event is a
  `note` with a title, which is a bespoke form of one field. **Two timers**:
  nursing (two mutually-exclusive accumulating sides, then Save) and sleep (one
  stretch, no sides). Everything else is instant, timestamped now.
- **Configurable = babies and users.** A settings screen with two lists, not a
  widget system.
- **Sleep is a timer**, not two buttons: start and stop, server-side like a
  feed, so either parent can end it. Backfill is the event editor.
- **Timers are shared and live across devices.** An in-progress feed is an
  `Event` with `ended_at = null`, created on first tap; the server owns the
  accumulators; clients poll every 3s while one is running.
- **Home screen** = last-event summary (relative times) → 2x3 log buttons with
  the mic in the middle → today's timeline.
- **Phase 4 rescoped**: cache + write outbox, no sync engine. Offline nursing
  still to do.
- **Insights are client-side**, median-based, and only average over days that
  have data.
- **iOS widgets + Live Activities** are Phase 8 — native WidgetKit work, App
  Group for data, `Text(style: .timer)` for ticking, App Intents for buttons.

## Where this stands — 2026-09-05

**Shipped and in daily use.** Both phones on TestFlight, both parents with
accounts, 225 events imported, web app at babylog-app.fly.dev as a fallback.
Phases 1–5 and Phase 9 part 1 done. 133 Django tests, 13 node suites.
403 events: 193 feeds, 175 diapers, 34 pumps, 1 free-form — and still no
sleep, three hours after the sleep timer shipped. Watch that number.

**Two release paths, and they are separate.** `fly deploy` ships the web app and
the API; `eas update --branch production --environment production` ships the JS
to the phones. Forgetting the second is why a change can be live on the web and
absent on a phone. Native changes (new packages, icon, version) still need
`eas build` + `eas submit`. Settings shows the running update id.

### Navigation

Three bottom tabs — **Home**, **Cal**, **Insights** — standard iOS height, icon
plus a small label, nothing that eats the timeline.

- **Home** is unchanged, minus the Insights link in its header, which became a
  duplicate route the moment Insights had a tab.
- **Cal** is new: **Day**, **Week** and **List** over the same data, plus a
  **month day-picker** so reaching last Tuesday is one tap instead of six.
  Days with events carry a dot, so an empty day is visible before you open it.
  The week fetch serves all three modes, so switching costs no request.
- **Week view** puts seven days on one 24h axis. Blocks carry no text at that
  width — the point is the shape of the week, not the detail of one feed. Tap a
  column header for that day, a block to edit it.
- **Insights** was already built, so the tab points at the real screen rather
  than a placeholder. Say the word if you wanted it blank.

The month grid is always 42 cells so its height never changes as you page
through months, and `src/month.test.mjs` covers year rollover, leap years,
Sunday-aligned rows and week labels that span two months.

The bar is **not** a `Tabs` navigator. Every log form and the event editor are
pushed screens with headers and back buttons, and a tab navigator above a stack
hides its bar the moment you push — so the bar disappeared exactly when you
wanted it. `src/TabBar.js` renders it as a sibling of the root `Stack` instead:
present on every screen, forms included, hidden only on sign-in and join. Tabs
`replace` rather than `push`, because a tab is a destination, not history;
re-tapping the tab you are on still scrolls to the top. The stack also sets
`headerBackTitle: 'Back'` — iOS otherwise labels the back button with the
previous screen's title, which for a tab screen was the route group: "(tabs)".

### Next feed

`Household.feed_interval_min` (default 180, bounded 15–1440) drives a banner at
the top of Home: when the next feed is expected, counted from when the last one
**started** — nursing or bottle, both are `type=feed` — so a long session does
not push the next one out by its own length. Overdue turns the card warm.
Configurable in Settings (1.5h–4h). Nothing is scheduled or notified off it;
that is Phase 7's job.

### What is actually left

**Every running timer is visible on the home screen.** Deliberately not a nudge
— just never hiding one. Four ways a timer could previously go unseen, all now
closed:

- only the *first* active timer got a banner, so two babies nursing showed one
- the banner was hardcoded to nursing colours and the word "Nursing", so any
  other interval type would have been mislabelled
- a timer started **offline** lives only on this device, so the server could not
  report it and the home screen showed nothing — the moment you most want to see
  it still counting. The banner now reads that local state too and says
  "on this phone only"
- the banner *replaced* the last-event summary; both show now, because "when did
  he last eat" is still the question mid-feed

The nurse screen also opens the timer for the **selected** baby rather than
whichever came back first.

No abandoned-timer prompt: a forgotten feed is now plainly visible rather than
silently accumulating, which is the part that actually mattered.

**Blocked on data, correctly:**
- **Phase 6 predictions** and **Phase 7 reminders** both need sleep history, and
  sleep is not being logged. Sleep now has a timer on the home screen as well as
  the voice path, which is two more ways in than it had; nothing else can start
  until a few weeks of rows exist.

**Phase 9 part 1 has shipped.** Voice in, draft cards, nothing written until a
person ticks a row. `gpt-5.6-luna` at $0.20/$1.20 per MTok, so the "few dollars
a month" estimate is closer to cents.

**The unexpected consequence worth watching: sleep may unblock itself.** Phases
6 and 7 have been parked on there being no sleep data, and the reason was never
the schema — `Event.SLEEP` has existed since Phase 1 — it is that nobody opens
an app to log a nap. `sleep` is in the parse schema's type enum, so *"he napped
from two to four"* already produces a sleep event with both ends, on the review
screen, with no new UI. If a fortnight of voice logging puts sleep rows in the
table, Phase 6 stops being blocked by data and starts being a real next step.
Watch the type counts rather than assuming it.

**After that:**
- **Phase 8 — Live Activities**, before the home-screen widget. An in-progress
  feed on the lock screen and Dynamic Island is where you would actually look at
  3am. Native work, so it needs a real build rather than an OTA update.
- **A learned feed interval**, per the note in Phase 6. Small, and the only
  thing here that gets better the longer the app runs.

**Home and Cal both draw today's timeline.** Not obviously wrong — Home wants
the day at a glance, Cal wants navigation. The *components* are no longer
duplicated: `DayList` and `Rollup` were each written twice and have been
extracted, which is how the pumped total came to print millilitres under an
ounces setting in one copy. Two screens, one component each.

**Things deliberately not built**, each still the right call: month grid (the
week strip is enough at ~22 events/day), CRDT sync (last-write-wins is fine for
two people), dark mode (tokens are in one file, so it is a 30-minute change when
the 3am screen blinds you), Android widgets, Apple Watch.

**A third bug class, and the most expensive of the three: an API shape written
from memory.** Phase 9 shipped broken three times on it — `Events.list()`
returns the response body while `cached()` returns `{data, stale}`, so
destructuring `{data}` off the raw call threw inside a `.catch(() => {})` and
the badge silently never appeared; `expo-speech-recognition` subscribes through
a *hook*, not the `addSpeechRecognitionListener` I invented, so the mic hit the
error boundary on first tap; and `requiresOnDeviceRecognition` fails unless
`supportsOnDeviceRecognition()` says yes, which made the sheet sit there
looking like it was listening. Every one was silent, and none was catchable by
a test written from the same wrong assumption. The rule is duller than a tool:
**open the module and read the signature before calling it** — `node_modules`
is right there, and it takes less time than one failed round trip to a phone.

**A bug class worth knowing about: undefined identifiers.** Bundling does not
resolve them, so `expo export`, `expo-doctor` and every web build pass happily
while the phone crashes on the first tap. Two shipped to TestFlight this way:
`event.id` (which silently resolved to `window.event` on web) and a call to
`guard(...)` that was dropped in a rewrite and never re-added.

I first wrote a narrow grep for browser globals, which caught the first and
sailed past the second. ESLint's **`no-undef`** catches both and is now the
blocking rule in `npm run check`. The lesson is the general one: a hand-rolled
check that covers the instance you just saw gives false confidence about the
class.

**A second bug class, and a more expensive one: a rule stated per-symptom.**
"How long was this feed" was fixed three separate times — first the span check
that contradicted the side totals, then the dead time after the last stretch,
then the dead time before the first. Each fix was correct and each left the
mirror image standing, because each was written against the symptom that got
reported rather than against the thing that was actually true. Stated as an
invariant — *a feed spans the stretches the timer ran, and nothing else* — all
three collapse into one clamp and one helper. The tell was that the second fix
needed the first fix's code moved to run before it; when the ordering between
two rules starts mattering, they are usually one rule that has not been named
yet.

**One piece of debt worth naming:** the import draft lives in client memory, so a
refresh mid-review loses it and you re-upload. Fine at 224 rows; revisit only if
you ever import something big.

### The tenancy audit, 2026-09-01

Every route checked against the question "can one household reach another's
anything". `TenancyScopingTests` and `CrossHouseholdIdTests` pin the answers so
they stay true.

Clean, and for a consistent reason — **the household is decided server-side, never
accepted from the client.** `perform_create` sets it on babies and events;
`BabySerializer` has no `household` field, so a baby cannot be reassigned by
PATCH; `InviteSerializer` is read-only but for `email`; every queryset filters
through `for_user()` or `membership__user`; and `EventSerializer.validate`
rejects a baby belonging to someone else. Foreign ids 404 rather than leaking
their existence.

Two things the audit did find, both from `HouseholdViewSet` being a plain
`ModelViewSet`:

- **`POST /api/households/` returned 201** and minted a household with no
  members — unreachable afterwards by anybody, including whoever created it.
- **`DELETE /api/households/{pk}/` returned 204 and cascaded**, taking every
  baby and every event with it. One call, no soft delete, no confirmation —
  while `BabyViewSet.perform_destroy` refuses to delete a baby that merely
  *has* events. The more destructive path had the less care.

Both are gone: `http_method_names = ["get", "patch", "head", "options"]`.
Households are made at setup and nothing in the app deletes one, so the two
verbs were free surface area rather than features.

**A correction the audit forced.** Several notes here said registration was
open. It is not, and never has been: `RegisterSerializer` requires an invite
code that exists, is unused and is unexpired, and it is the only
unauthenticated write in the API. That mistake had reached the portfolio
description on a public site, where it told visitors they could sign up.

## Open questions

1. **Pump sides.** Only affects per-side labels. Totals are right regardless —
   not worth blocking on.
2. **Does the pump belong to a person?** Household event today; `created_by`
   already records who logged it if that turns out to be enough.
