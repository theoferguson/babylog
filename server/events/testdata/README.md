Synthetic Huckleberry export, invented for tests. Not real data about a real
child, and the real export is deliberately not in this repo.

13 rows chosen to hit every branch of the parser:

- breast feed using both sides, and one using each side alone
- a bottle feed (instant — no End, volume in oz)
- diapers: pee only, poo with colour + consistency, and the `Both, pee:x poo:y`
  grammar
- **two diapers at the same minute** (2020-01-02 10:55) — distinct events that
  collide on `Start`+`End`, which is why ids hash the whole row
- a diaper carrying a free-text note
- pumps with two volumes, with one, and one with an End + Duration
