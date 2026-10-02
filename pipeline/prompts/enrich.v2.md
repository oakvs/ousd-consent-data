# Task: turn OUSD Board consent items into structured, plain-English JSON (prompt v2)

You are enriching items from the Oakland Unified School District (OUSD) Board of Education "General Consent Report" for a public transparency tool. Readers are parents, reporters and board members who are not finance or legal experts. They most want to know: what is this, who gets paid, how much, for what, and is there anything unusual about how it was approved.

Your input file is JSON: `{ chunk, meetingKey, meetingDate, items: [...] }`. Each item has `file`, `agendaNumber`, `title` (official short title), `text` (official full action text — **THE ONLY SOURCE OF TRUTH**), `matterType`, `presenter`, `group` and `fundingSource`.

Write your output file as JSON: `{ "chunk": "<same chunk id>", "items": [ ... ] }`, with **exactly one object per input item, in the same order**, shaped like this:

```json
{
  "file": "26-1329",
  "headline": "string",
  "summary": "string",
  "category": "one of the CATEGORY values",
  "actionType": "one of the ACTION TYPE values",
  "vendor": { "name": "string or null", "location": "string or null" },
  "schools": ["school names, only if the item names specific schools or sites; else []"],
  "money": {
    "direction": "expense | revenue | decrease | no_cost",
    "amountType": "not_to_exceed | fixed | cumulative | per_year | sales_cap | null",
    "thisAction": 1234.56,
    "thisActionRange": null,
    "priorTotal": null,
    "newTotal": null,
    "byYear": {},
    "evidence": "exact substring copied from text containing the thisAction figure"
  },
  "term": { "start": "YYYY-MM-DD or null", "end": "YYYY-MM-DD or null", "addedStart": "YYYY-MM-DD or null" },
  "flags": [],
  "sourceIssueCandidate": null,
  "uncertain": []
}
```

## Field rules

**headline**: at most 110 characters (hard limit 140). Plain English. Start with a verb or a clear noun phrase. Include the dollar amount if there is one, and the vendor or partner by its common name. Example: "Adds $1.02M to keep Frontline's staff absence, evaluation and training software through 2029".
- Don't put individual people's names in headlines when the organization or role says enough ("Pays a school psychology intern up to $30,000…"). Names can stay in the official text.
- Use neutral language, with no adjectives like "huge", "controversial" or "wasteful".

**summary**: 2–3 short sentences at about an 8th-grade reading level (hard limit 900 characters).
- Say what the money actually buys or what the agreement does, who benefits (which students, schools or departments), and the time period.
- If it's an amendment, say what changed: more money, more time, or more scope.
- If the district is buying without its own competitive bid, say so plainly in one neutral clause (e.g. "The district is buying through another agency's existing contract instead of running its own bid.").
- If the work started before approval, say so neutrally.
- Don't speculate beyond the text, and don't editorialize.

**No jargon.** In the headline and summary, never use these without spelling them out the first time, e.g. "California Multiple Award Schedules (CMAS)":
- CMAS, Graydon (say "a legal exception to public bidding (called the Graydon exception)")
- LLB (lease-leaseback)
- SPSA (School Plan for Student Achievement)
- MOU (memorandum of understanding)
- NPS/NPA (nonpublic school/agency)
- PCO (preliminary change order)
- IEP (Individualized Education Program)
- DSA (Division of the State Architect, or data-sharing agreement: whichever the text means)

**category**: pick the single best fit for what the item is FOR.
- "Special education": nonpublic school/agency contracts, special-ed transport, related services, school psychology interns, special-ed legal
- "Classroom & academic programs": curriculum, instruction, teacher training tied to instruction, field trips, college and career pathways
- "After-school & summer programs": expanded learning lead agencies, enrichment providers, summer programs
- "Student health, support & family services": health centers, counseling, translation, family engagement, newcomer support
- "School buildings & construction": bond projects, design, construction management, inspections, environmental work for projects, change orders
- "Food, transportation & operations": nutrition purchasing, activity buses, waste, routine maintenance, furniture, supplies, auctions
- "Technology": software licenses, devices, IT services (unless bought for a program that's clearer)
- "Staff & hiring": personnel reports, job descriptions, union agreements, recruitment, workforce grants
- "Legal, insurance & risk": outside counsel, claims administration, insurance premiums, risk services (special-ed legal goes to Special education)
- "School plans": School Plans for Student Achievement
- "Partnerships & data sharing": only for no-cost MOUs or data-sharing agreements whose purpose doesn't fit a program category better
- "Governance & board business": resolutions, commission items, board policies, real property, minutes, appointments

**actionType**: one of these values:
- "new_agreement"
- "amendment"
- "change_order"
- "bid_award"
- "cooperative_purchase" (piggyback, CMAS, or another agency's contract)
- "mou_or_data_sharing"
- "grant_or_funding_in"
- "school_plan"
- "personnel"
- "resolution_or_policy"
- "termination"
- "other"

## Money rules (these matter most)

1. **Only use dollar figures that literally appear in `text`.** Never compute, add, round or infer. Numbers must be JSON numbers (no `$` or commas). If a figure isn't stated, use `null`.
2. **`thisAction`** is the amount this specific vote adds, authorizes or receives.
   - For amendments, it's the ADDED amount, not the new total.
   - For decreases, it's the positive reduction, with `direction: "decrease"`.
   - For grants and funding coming in, use `direction: "revenue"`.
   - If the item says $0 or no cost: `direction: "no_cost"`, `thisAction: null`.
3. **`priorTotal` / `newTotal`**: fill these only when the text states them (e.g. "increasing … from $X to $Y").
   - **If an amendment states only the new overall (cumulative) total and not the added amount, set `thisAction: null`.** Put that total in `newTotal`, and any stated earlier total in `priorTotal`. Never put a contract's overall total in `thisAction` for an amendment: it would count the whole contract as new spending.
   - Year-by-year figures go in `byYear`, not in `thisAction`.
4. **Yearly limits.** If the amount is a limit per year ("per year", "annual", "each fiscal year", "per contract year", "in a fiscal year"), use `amountType: "per_year"`.
   - If a yearly range is given ("between $13,083,445 and $17,608,594 per year"), set `thisActionRange: [low, high]` and put the HIGH figure in `thisAction`.
   - Otherwise `thisActionRange` is `null`.
5. **Auction or sales caps** (money the district may *receive* from sales, not spend): `direction: "no_cost"`, `amountType: "sales_cap"`, `thisAction: null`.
6. **`byYear`**: fill this only if the text breaks the amount down by year, e.g. `{"2026-27": 323511.63}`. Otherwise `{}`.
7. **Several vendors or amounts in one item**: use the total if the text states one. Otherwise use the largest single stated amount, name the others in the summary, and add `"money"` to `uncertain`.
8. **$0 master agreements** (task orders to follow): `direction: "no_cost"`, and the summary says future task orders will come back separately.
9. **`evidence`**: copy EXACTLY, character for character (spacing, punctuation, typos and all), a short substring of `text` (≤ 200 characters) that contains the `thisAction` figure. Use `null` if `thisAction` is null.

## Term

- `start` / `end`: the agreement's or service period's dates, if stated. Convert "July 1, 2026" → "2026-07-01". A school year like "2026-2027" with no dates → start "2026-07-01", end "2027-06-30".
- `addedStart`: for amendments and extensions, the date the NEWLY ADDED period starts, if stated (e.g. "extending the term from June 30, 2026 to June 30, 2041" → "2026-07-01"). Otherwise `null`.

## Flags

Include every one that applies, based only on the text:
- "no_competitive_bid": piggyback, cooperative purchase, CMAS, Graydon exception, sole source, a "best interest of the District" finding to forgo bidding, or an emergency contract
- "multi_year": the term spans more than one school year (more than ~13 months)
- "time_extension_only": the change only extends time, with no added money
- "emergency": the text describes emergency work or contracting

Don't add any other flags. "After work began", "raises existing contract", "delayed at an earlier meeting" and similar flags are computed in code.

## sourceIssueCandidate and uncertain

- **`sourceIssueCandidate`**: if the text's own numbers don't add up (prior + added ≠ new), the title contradicts the action text, an amount looks misprinted (e.g. "$8,639.911.00"), or the item looks like a duplicate, describe it in one neutral sentence. Otherwise `null`. A human will confirm it before it's published.
- **`uncertain`**: list the field names you're unsure about (e.g. `["money", "category"]`), or `[]`.

## Process

1. Read your input file.
2. Work through every item carefully. Accuracy matters more than speed: this will be published.
3. Write the output file (valid JSON, no comments, no trailing commas).
4. **Validate it** with the command you were given. It checks the schema, that every `evidence` is an exact substring of `text`, and that every amount appears in `text`. Fix every error it reports and re-run until it passes, at most 3 rounds. If an amount truly appears in the text in an unusual form (e.g. a misprint), keep the figure and explain it in `sourceIssueCandidate`.
5. Reply with only: the chunk id, the number of items written, whether validation passed, and any items you were unsure about (agenda number plus a one-line reason).
