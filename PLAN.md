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
| Backend | **Django + DRF + Postgres on Fly** | You already run this stack and know its deploy story. |
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

---

## What Huckleberry actually does — and what to copy

Sourced from Huckleberry's own marketing, a UI teardown, and reviews. **Not from
screenshots** — the App Store listing blocked automated fetches. Treat as
structural, not pixel-level; verify against the real app on your phone.

### Logging is bespoke per type

**There is no generic event form.** Each type gets its own screen, shaped to how
that thing is actually recorded. Only nursing has a live timer.

#### Nurse — the only timer
Two big buttons, **L** and **R**. Tap one to start it, tap again to stop; tapping
the other **stops the running side and starts that one**. Then **Save**.

Verified against your export: 0 of 98 feeds have overlapping sides, so
mutual exclusion is right. 65 use both sides, 33 use one.

Each side is an **accumulator**, not a single stretch — you switch back and
forth, so R→L→R adds into `right_sec`. The export only ever stores per-side
totals, so segment order is not recoverable and not worth storing.

```
started_at = first tap of any side
ended_at   = Save
right_sec, left_sec = accumulated per side
last_side  = which side ran last   <- powers "start on L" on the home screen
```

`last_side` is one string and is the thing nursing parents actually want to know
at 3am. Not in Huckleberry's export; add it anyway.

**The timer must survive the app being closed.** Persist `{running_side,
segment_started_at, right_sec, left_sec}` to AsyncStorage on every tap, and
show a resumable in-progress banner on launch. A timer that dies when you
switch apps is worse than no timer.

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

**Status:** built and tested locally — 18 tests green against the synthetic
fixture. Remaining: `fly launch` + Postgres (yours to run; see README), then
import your own export.

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

### Phase 2 — Log + day view
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

**Done when:** both phones have it, you log a real day on it, and you'd rather
open it than Huckleberry.

### Phase 3 — Calendar navigation + edit
Move between days and see patterns across them:
- **Week strip** above the timeline — tap to jump, density per day.
- **List view** — flat reverse-chron across days, for scanning and searching.
  Nearly free once the timeline exists; both read the same query.
- **Tap any event to edit or delete**, using the Phase 2 forms in edit mode.
- **Backdated entry** — logging a feed you forgot two hours ago. Needed more
  often than it sounds.

This completes the "record / edit / add" requirement.

### Phase 4 — Sync hardening
The outbox, the persisted cache, conflict handling, an "offline / N pending"
indicator. Deliberately *after* Phase 3 — build the UI against a live server
first, then make it survive the subway.

### Phase 5 — Insights
Sleep totals per day/night split, feeds per day, average interval, diaper counts,
weight curve. All read-only aggregation over the one event table; most are a
single grouped query. Charts via `victory-native` (works on web too).

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

## Settled

- **Units: metric canonical**, imperial is a client-side display preference.
- **Imports are previewed, editable and checkable per row**; commit is
  per-row with a partial-success report, not all-or-nothing.
- **One baby, Henry.** Full baby setup UI built anyway; switcher hides at n=1.
- **Theme: light and soft.** Warm off-white, coral accent, and a fill/ink pair
  per type — CVD-verified, min ΔE 13.6 on fills across all colourblindness types.
- **Two logins**, one each. `Membership` and `created_by` stay — worth knowing
  who logged what at 3am.
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
- **Home screen** = last-event summary (relative times) → 2x2 log buttons →
  today's timeline.

## Open questions

1. **Pump sides.** Only affects per-side labels. Totals are right regardless —
   not worth blocking on.
2. **Does the pump belong to a person?** Household event today; `created_by`
   already records who logged it if that turns out to be enough.
