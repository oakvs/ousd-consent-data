# Task: light public research on one OUSD vendor (vendor-research v2)

You're researching one vendor that appears on the Oakland Unified School District (OUSD) Board of Education's General Consent Report, for a public transparency tool. The goal is a short, accurate "About this vendor" box: what the organization does, its website, and its public business contact and registry details.

**Individuals are out of scope.** If the vendor turns out to be a person contracting in their own name (not a business, nonprofit or agency), stop. Set `confidence: "none"`, `profile: null`, `sources: []`, and `notes: "individual"`. Do not research the person.

**Keep it light:** usually 2–4 searches and at most about 6 page fetches. Registries and the organization's own About/Contact pages are usually enough.

**Being wrong is much worse than being incomplete.** If you can't be sure you've found the right organization, say so and stop. A wrong website or phone number on a public page about a real organization is a serious error.

## Input

Your input file is JSON describing what OUSD's official records say about this vendor:

- `namesInAgendaText`: how the vendor is named in the agenda (may include "dba" names)
- `locationsInAgendaText`: the city or state the agenda gives, if any
- `vendorNo`: OUSD's internal vendor number. This is NOT a public registry ID; don't search for it.
- `whatOusdContractsThemFor`, `presentingOffices`, `officialTitles`, `fundingSources`: what the district buys from them

## Scope

**In scope:**
- what the organization does
- whether it's a nonprofit, a company or a public agency
- its website
- its main public phone number, general email and mailing address
- headquarters city
- registry IDs: IRS EIN for nonprofits, California Secretary of State entity number, SAM.gov UEI

**Out of scope:**
- news, reviews, lawsuits, complaints or opinions
- staff names, or any individual's personal email or phone
- donors, finances or politics
- anything not needed for the fields above

## Where to look, in order of trust

1. **Public registries for facts:**
   - ProPublica Nonprofit Explorer (projects.propublica.org/nonprofits) or the IRS Tax Exempt Organization Search for nonprofits: EIN, legal name, city
   - California Secretary of State business search (bizfileonline.sos.ca.gov)
   - SAM.gov entity search
2. **The organization's own website** for what it does and its contact details. Prefer the About and Contact pages.
3. **Other reputable pages** only to confirm identity, e.g. another public agency's page about the same organization.

Use WebSearch to find candidates and WebFetch to read pages. Fetch every page you cite.

## Identity: is this really the same organization?

Before filling in anything, confirm the match using **at least two independent signals**, and list them in `identitySignals`. For example:
- "Name matches a registered nonprofit: 'Fred Finch Youth Center' (ProPublica, EIN shown)"
- "Located in Oakland, CA, matching the agenda text"
- "Website describes youth mental-health services, matching OUSD's 'Student health, support & family services' contracts"
- "Website or a public page mentions working with Oakland Unified / OUSD schools"

Watch for organizations with similar names in other states, chains versus local franchises, and parent companies versus subsidiaries. When the agenda gives a city, the organization you found must be in, or clearly serve, that place.

Confidence:
- `high`: two or more strong, independent signals, and nothing contradicts them
- `medium`: probably right, but one signal is weak or something is off
- `low`: a plausible candidate, not confirmed
- `none`: no credible candidate found

Only `high` results can be published. Don't inflate confidence.

## Output

Write your output file as JSON:

```json
{
  "key": "<the vendor key, from the input file name>",
  "identitySignals": ["…", "…"],
  "confidence": "high | medium | low | none",
  "profile": {
    "legalName": "string or null",
    "summary": "2–3 neutral sentences on what the organization does",
    "orgType": "nonprofit | company | public_agency | other | null",
    "website": "https://… or null",
    "phone": "(510) 555-0100 or null",
    "email": "info@example.org or null",
    "address": "123 Main St, Oakland, CA 94612 or null",
    "headquarters": "Oakland, CA or null",
    "ein": "94-1234567 or null",
    "caEntityNumber": "string or null",
    "samUei": "string or null"
  },
  "sources": [
    { "url": "https://…", "title": "page title", "supports": ["summary", "website", "phone"] }
  ],
  "notes": "anything a reviewer should know, or null"
}
```

If confidence is `none`, set `profile` to null and `sources` to [].

### Field rules

- **summary:** at most 600 characters, about an 8th-grade reading level. Describe what the organization does in general (e.g. "a nonprofit that runs after-school and summer programs for Bay Area youth"), not what OUSD bought. Neutral and factual: no praise, no marketing language, no claims you can't source. Spell out acronyms.
- **Contact details** (phone, email, address): business contact only, copied exactly as the cited page shows them. Use the main line, a general inbox (info@, contact@) and the mailing or headquarters address. Never a named person's email or direct line.
- **Every non-null field** must be listed in `supports` on at least one source that shows it. The phone, email, address, EIN, entity number, UEI and legal name must appear **exactly** on a page you cite for them. List `summary` and `orgType` on the pages that support them too.
- If you can't find a field, use null. Don't guess.

## Process

1. Read your input file.
2. Research. Confirm identity first.
3. Write the output file (valid JSON).
4. Validate with the command you were given. It fetches every cited page and checks that each contact detail and registry ID appears on a page cited for it. Fix every ERROR: correct the citation, or remove the field. Re-run until it prints PASS, at most 3 rounds. WARNINGs about pages that block automated fetching are fine; those fields will just be dropped.
5. Reply with only: the vendor key, your confidence, and a one-line reason.
