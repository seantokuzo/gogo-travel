/**
 * Travel-document vault (contracts spec §3.4; schema spec §3.3.22).
 * Strictly private to the owning user (R-db-18) — a `trip_id` association
 * NEVER grants trip members visibility.
 */
import { z } from "zod";
import { DocumentKindSchema } from "../enums.js";
import { ISODateSchema, ISODateTimeSchema, UuidSchema } from "../scalars.js";

export const TravelDocumentSchema = z.object({
  id: UuidSchema,
  user_id: UuidSchema,
  /** Association only ("visa for the Japan trip"). */
  trip_id: UuidSchema.nullable(),
  kind: DocumentKindSchema,
  title: z.string(),
  /** Scan/photo object key; null = metadata-only reminder entry. */
  storage_key: z.string().nullable(),
  expires_at: ISODateSchema.nullable(),
  /** null = no reminder. */
  remind_days_before: z.int().positive().nullable(),
  /** Reminder-job dedup. */
  last_reminded_at: ISODateTimeSchema.nullable(),
  created_at: ISODateTimeSchema,
  updated_at: ISODateTimeSchema,
});
export type TravelDocument = z.infer<typeof TravelDocumentSchema>;
