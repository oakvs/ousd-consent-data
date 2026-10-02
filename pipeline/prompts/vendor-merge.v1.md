# Task: decide whether OUSD vendor records are the same organization (vendor-merge v1)

You're helping a public transparency tool that tracks the Oakland Unified School District (OUSD) Board of Education's consent agenda. Each vendor gets a public page listing every item the Board approved with it, with totals. Sometimes one organization shows up as several vendors, because Legistar spells its name differently from year to year, or because OUSD has more than one vendor number for it. Your job is to decide which records should be combined into one page.

**A wrong merge is much worse than a missed one.** Merging two different organizations puts one organization's contracts and dollars on another's public page. Leaving a duplicate only splits one organization's history across two pages. When in doubt, keep them separate.

## Input

Your input file is JSON: `{ batch, groups: [...] }`. Each group lists two to six vendor records that might be the same organization. For each record you get:

- `key`: the record's id. Ones starting `v-` have an OUSD vendor number; `n-` ones are identified by name only.
- `names`: how the agenda text names it
- `vendorNo`, `locations`, `categories` (what OUSD buys from it), `departments` (which offices bring its items)
- `items`, `firstSeen`, `lastSeen`, and `sampleTitles` (official item titles)
- `profile`: a verified description and website, when one exists

## How to decide

Merge records only when they are clearly **the same legal organization**:

- the same name written differently: punctuation, "Inc.", "LLC", "& Company", "a Professional Corporation", "Law Firm", "Attorneys at Law", or an added acronym such as "(BAMA)"
- the same name and the same kind of work, where locations agree or are missing
- the same name under two OUSD vendor numbers, when everything else matches. OUSD sometimes has two vendor records for one organization.

Keep records separate when:

- one is part of the other: a university and one of its schools, centers or programs; a state department and one of its divisions; a county agency and a different county agency
- they are different schools or sites of the same network, such as two Aspire or KIPP schools, or different charter schools
- the names share words but describe different organizations, or the locations or the kind of work disagree
- one record names a person, or a joint arrangement of several organizations, rather than one organization
- you can't tell

A group can be partly merged. For example, three records where two are clearly the same and the third is a different organization.

## Output

Write your output file as JSON:

```json
{
  "batch": "<same batch id>",
  "decisions": [
    {
      "group": "g001",
      "into": "v-000624",
      "merge": ["n-bay-area-community-resources", "v-000634"],
      "reason": "One sentence on why these are the same organization, or why not."
    }
  ]
}
```

- Exactly one decision per group, in the same order.
- `merge`: the keys to fold into `into`. Use `[]` and `"into": null` to keep every record in the group separate.
- `into` must be one of the group's keys. If anything being merged has a vendor number (`v-`), `into` must be a `v-` key; prefer the one with the most items. Otherwise, use the record with the most items.
- `reason` is one neutral sentence. It's kept in a public log.

## Process

1. Read your input file.
2. Decide each group.
3. Write the output file (valid JSON).
4. Validate with the command you were given. Fix every ERROR and re-run until it prints PASS, at most 3 rounds.
5. Reply with only: the batch id, how many groups you merged, and how many you kept separate.
