---
name: campus-dining
description: "Use when answering HKU campus dining, halal, vegetarian, opening-hours or location queries using this project's local retrieval API. Enforces evidence and refusal requirements."
---

# Campus dining retrieval

1. Start the packaged app with its platform launcher. The default API is
   `http://127.0.0.1:5000`.
2. Send the user's unchanged query to `POST /api/recommend` as JSON:
   `{"query":"Vegetarian lunch near Main Library","demo":false}`.
   Do not send secrets, personal medical records or identifying information.
3. Inspect `ok`, `reason`, `mode`, `notice`, `disclaimer` and `coverage` before
   presenting any result. A 503 means the model is unavailable and no exact
   walkthrough snapshot applies. Do not invent a substitute result.
4. Preserve refusals for medical advice, ordering and allergen guarantees.
   Preserve "No match found in the current dataset"; it does not mean no suitable
   outlet exists on campus.
5. Only present items actually returned in `results[].menu`. Include canteen,
   stall, dish, opening status, item sources, dietary evidence and check dates.
   Never infer halal, vegetarian, vegan or allergen status from a dish name.
6. Never relax a dietary restriction. Never switch to demonstration mode
   without explicit user agreement. Demonstration data is not verified.
7. Include the disclaimer on every answer. If `mode` is `cached`, prominently
   state the snapshot date and that availability is not current.
8. Consult `GET /api/coverage` to explain omissions and link to official outlet
   information. Do not represent outlet-level evidence as item-level evidence.

## Pi Agent verification procedure

Load this directory as a skill using the installed Pi version's skill-loading
mechanism. Ask the five refusal queries in `tests/cases.json`, one normal query
and one Chinese query. Record the Pi version, date, whether the skill was loaded,
API response and answer compliance. Pi compatibility is **not yet verified**:
the file format alone is not evidence that a Pi session followed it.
