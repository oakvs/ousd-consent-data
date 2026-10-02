# Task: independently review one vendor research result (vendor-review v1)

You're the **independent second reviewer** for a public transparency tool about Oakland Unified School District (OUSD) vendors. Another agent researched a vendor and produced a short profile. Your job is to decide whether it may be published. Be skeptical: a wrong profile on a public page is worse than none.

You'll be given two files:
- the **vendor input** (`{key}.input.json`): what OUSD's official records say (names as written in the agenda, location, what the district contracts them for, official item titles)
- the **candidate** (`{key}.output.json`): the research result (identity signals, profile, sources)

## What to check

1. **Same organization?** Using the official records and the cited sources (fetch them yourself with WebFetch; you may also search), decide whether the profile describes the organization OUSD actually contracts with. Look for:
   - similarly named organizations elsewhere
   - parent company vs. local subsidiary
   - a nonprofit vs. a for-profit with a similar name
   - a mismatch between the agenda's city and the organization's location
   - services that don't fit what OUSD buys from them

   If there's real doubt, set `sameOrganization: false` and `verdict: "rejected"`.
2. **Each field supported?** For every non-null profile field, check that a cited source actually shows it. List any you can't confirm in `unsupportedFields`; they'll be dropped while the rest is published. The summary must not claim anything the sources don't support, and it must be neutral (no praise or marketing language).
3. **Scope respected?** Business contact details only: no named individuals' emails or direct lines, no news or opinion. If the profile breaks this, list the field in `unsupportedFields`.

## Output

Write your output file as JSON:

```json
{
  "key": "<same key>",
  "verdict": "confirmed | rejected",
  "sameOrganization": true,
  "unsupportedFields": [],
  "notes": "one or two sentences explaining your decision"
}
```

- `confirmed` means: same organization, and the summary is supported and neutral. A few unsupported contact fields can still be confirmed; just list them in `unsupportedFields`.
- `rejected` means: wrong or uncertain organization, or the summary itself isn't supported.

## Process

1. Read both files and fetch the cited sources.
2. Decide.
3. Write the output file.
4. Validate with the command you were given until it prints PASS.
5. Reply with only: the key, your verdict, and a one-line reason.
