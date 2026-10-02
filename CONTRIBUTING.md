# Contributing

Thanks for wanting to help. Corrections from people who know these contracts, schools and vendors are the best way to make this data better, and every one is greatly appreciated.

The usual heads-up applies: this is maintained by one busy dad in his spare time. Pull requests get read, but sometimes not quickly. Small, focused changes with a clear explanation are the easiest to review.

Not up for a pull request? [Opening an issue](https://github.com/oakvs/ousd-consent-data/issues/new/choose) is just as welcome. And if the problem is in OUSD's official record on Legistar rather than in this project's summaries, see [Found a mistake?](README.md#found-a-mistake) in the README. Only the district can fix those.

## Correcting an item

Corrections go in `data/overrides/`, one file per meeting. They sit on top of what the AI wrote and always win. Please don't edit `data/raw/`, which is the official record as copied from Legistar, or `data/published/` and `data/exports/`, which are generated.

1. Fork this repository and clone your fork.
2. Install dependencies with `npm ci` (Node 22 or newer).
3. Open `data/overrides/{meeting}.json`, for example `data/overrides/2026-09-23.json`. If it doesn't exist yet, create it with `{ "meetingKey": "2026-09-23", "items": {} }`.
4. Add an entry under `items`, keyed by the item's file number. Include only the fields you're correcting. This example is only an illustration, and its amount is made up:

   ```json
   {
     "meetingKey": "2026-09-23",
     "items": {
       "26-1736": {
         "fields": {
           "headline": "Sets up a $0 master agreement with Terraphase Engineering for civil engineering at school sites",
           "money": { "thisAction": 125000, "evidence": "in an amount not to exceed $125,000.00" }
         },
         "sourceIssue": null,
         "reviewer": "your-github-username",
         "reviewedAt": "2026-10-15",
         "note": "Corrected the amount: the summary used the prior total instead of the added amount."
       }
     }
   }
   ```

   - `fields` can hold `headline`, `summary`, `category`, `actionType`, `vendor`, `schools`, `money`, `term` and `flags`. Within `money` you can set just the parts you're changing. `vendor` and `term` need to be given whole, like `{ "name": "…", "location": "…", "kind": "organization" }`.
   - Any dollar amount you add needs an `evidence` passage copied exactly from the official text, the same rule the AI is held to.
   - `sourceIssue` is for a real error in the official text itself, like totals that don't add up. Describe it in one neutral sentence, or leave it `null`.
   - `reviewer` is your GitHub username, and `reviewedAt` is today's date. Together they mark the item as reviewed by a person.
   - `note` is shown publicly on the item as a correction note. Use it when you're changing something that was already published, and say plainly what changed. Otherwise set it to `null`.
   - The allowed values for `category`, `actionType` and `flags` are in [`packages/consent-schema/src/schema.ts`](packages/consent-schema/src/schema.ts). The README's flags table explains each one.
5. Rebuild and test:

   ```bash
   npm run consent:build
   npm test
   ```

   The build regenerates `data/published/` and `data/exports/` with your correction applied. Commit those changes along with your override, because the tests check that the published files match a fresh build.
6. Open a pull request. Say which item you corrected and why, and quote the official text that backs it up.

A correction also applies to the same file number at other meetings, as long as the official text is identical. That's handy for items that come back for amendments.

## Vendor profiles

Vendor profiles live in `data/vendor-research/`. They pass automated checks against their cited sources when they're created, so editing a profile by hand would skip those checks. If a profile describes the wrong organization or has wrong contact details, the quickest safe fix is to hide it. Set `"publishable": false` in its file, rebuild and test as above, and explain in the pull request what's wrong, linking the source that shows it. Opening an issue works too.

## Code changes

Code improvements are welcome too. For anything bigger than a small fix, please open an issue first so we can talk it over before you put in the time. [`pipeline/README.md`](pipeline/README.md) explains how the pipeline fits together.

- The code is TypeScript, run with `tsx`. `npm run type-check` and `npm test` should both pass.
- Keep the build deterministic. The same inputs have to produce byte-identical output.
- If you change `packages/consent-schema`, run `npm run schema` and commit the regenerated `schema/` folder.
- A change to a prompt in `pipeline/prompts/` gets a new version number in a new file, not an edit in place, so older records keep pointing at the instructions that produced them.

## A few ground rules

- Keep the language neutral. Summaries and notes describe what the official record says, not what anyone should think about it.
- Don't add personal information about anyone. That means no private contact details, and no naming people who contract in their own name in headlines.
- Corrections should be backed by the official text, or for vendor profiles, by public sources you can link to.

By contributing, you agree that your contributions are licensed under this repository's licenses: [MIT](LICENSE) for code and [CC BY 4.0](LICENSE-DATA) for data.
