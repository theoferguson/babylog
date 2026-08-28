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

## API

| | |
|---|---|
| `POST /api/auth/token/` | username + password → token |
| `GET/POST /api/events/` | filters: `baby`, `type`, `since`, `until` |
| `GET /api/events/latest/` | one row per type, for the home screen |
| `DELETE /api/events/{id}/` | soft delete |
| `/api/babies/`, `/api/households/` | setup |

Volumes, weights and lengths are **always metric** on the wire (ml, g, cm).
`Household.units` is a display preference the client applies.
