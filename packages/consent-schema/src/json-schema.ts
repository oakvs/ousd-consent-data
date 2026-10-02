/**
 * JSON Schema (draft 2020-12) for every file in the data repo, generated
 * from the zod schemas with `z.toJSONSchema`. The committed copies live in
 * `schema/` at the repo root; `npm run schema` regenerates them.
 */
import { z } from 'zod'

import {
  EnrichmentsFile,
  IndexFile,
  MeetingFile,
  MeetingListFile,
  OverridesFile,
  RawSnapshot,
  Registry,
  SCHEMA_VERSION,
  UpcomingFile,
  VendorFile,
  VendorIndexFile,
  VendorLegistarFile,
  VendorResearchRecord,
  VerificationsFile,
} from './schema'

export const SCHEMA_BASE_URL = 'https://raw.githubusercontent.com/oakvs/ousd-consent-data/main/schema'

/**
 * File name → [zod schema, title, files it describes, io]. Published files
 * are written fully parsed, so they get the `output` shape (defaults filled
 * in). Pipeline inputs get the `input` shape: fields with a default may be
 * missing from older files.
 */
const SCHEMAS: Record<string, [z.ZodType, string, string, 'input' | 'output']> = {
  'meeting.schema.json': [MeetingFile, 'Meeting', 'data/published/meetings/{key}.json', 'output'],
  'meeting-list.schema.json': [MeetingListFile, 'Meeting list', 'data/published/meetings/{key}.list.json', 'output'],
  'index.schema.json': [IndexFile, 'Meeting index', 'data/published/index.json', 'output'],
  'vendor.schema.json': [VendorFile, 'Vendor', 'data/published/vendors/{key}.json', 'output'],
  'vendor-index.schema.json': [VendorIndexFile, 'Vendor index', 'data/published/vendors/index.json', 'output'],
  'upcoming.schema.json': [UpcomingFile, 'Next meeting', 'data/published/upcoming.json', 'output'],
  'raw-snapshot.schema.json': [RawSnapshot, 'Raw Legistar snapshot', 'data/raw/{key}.json', 'input'],
  'enrichments.schema.json': [EnrichmentsFile, 'AI enrichments', 'data/enrichments/{key}.json', 'input'],
  'verifications.schema.json': [VerificationsFile, 'Second readings', 'data/verifications/{key}.json', 'input'],
  'overrides.schema.json': [OverridesFile, 'Human overrides', 'data/overrides/{key}.json', 'input'],
  'registry.schema.json': [Registry, 'Meeting registry', 'data/meetings.json', 'input'],
  'vendor-legistar.schema.json': [VendorLegistarFile, 'Legistar records per vendor', 'data/legistar/vendors/{key}.json', 'input'],
  'vendor-research.schema.json': [VendorResearchRecord, 'Vendor research', 'data/vendor-research/{key}.json', 'input'],
}

export function jsonSchemas(): Record<string, object> {
  return Object.fromEntries(
    Object.entries(SCHEMAS).map(([file, [schema, title, describes, io]]) => [
      file,
      {
        $id: `${SCHEMA_BASE_URL}/${file}`,
        title,
        description: `${describes} (schema version ${SCHEMA_VERSION}). Generated from packages/consent-schema; do not edit by hand.`,
        ...z.toJSONSchema(schema, { io }),
      },
    ]),
  )
}
