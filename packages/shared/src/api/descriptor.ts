/**
 * Endpoint descriptors + DI seam (contracts spec §3.6).
 *
 * Shared defines the port; apps provide the adapter (R-shared-9). Shared
 * exports ZERO hooks — it exports the descriptors hooks are generated from:
 * `apps/mobile` builds TanStack Query hooks generically from descriptors over
 * an injected `ApiClient`; `apps/server` uses the same descriptors to type
 * `@hono/zod-validator` middleware and response payloads.
 */
import type { z } from "zod";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/**
 * The machine-readable mirror of a route defined in `.specs/api/*`.
 * Each domain module exports its endpoints' descriptors alongside its
 * schemas as the corresponding API task lands (AU-1, MON-*, …).
 */
export interface EndpointDescriptor {
  method: HttpMethod;
  /** Route pattern, e.g. `'/trips/:tripId/bookings'`. */
  path: string;
  /** Path-param schema (object of `:name` → value). */
  params?: z.ZodType;
  /** Query-string schema. */
  query?: z.ZodType;
  /** Request-body schema. */
  body?: z.ZodType;
  /** Response schema — implementations parse responses with it (both-direction runtime validation). */
  response: z.ZodType;
}

type InputPart<K extends string, S> = S extends z.ZodType ? { [P in K]: z.input<S> } : unknown;

/** Typed input for a descriptor: only the parts the descriptor declares. */
export type InferInput<D extends EndpointDescriptor> = InputPart<"params", D["params"]> &
  InputPart<"query", D["query"]> &
  InputPart<"body", D["body"]>;

export type InferResponse<D extends EndpointDescriptor> = z.output<D["response"]>;

/**
 * The transport port (types only — no I/O here, R-shared-9).
 * Implementations MUST parse the response with `descriptor.response` before
 * returning, so the wire is runtime-validated in both directions.
 */
export interface ApiClient {
  request<D extends EndpointDescriptor>(
    descriptor: D,
    input: InferInput<D>,
  ): Promise<InferResponse<D>>;
}

/**
 * Stable addressing for descriptors (e.g. `OfflineMutation.descriptor_key`,
 * TanStack Query key derivation). `"METHOD path"`.
 */
export function descriptorKey(descriptor: Pick<EndpointDescriptor, "method" | "path">): string {
  return `${descriptor.method} ${descriptor.path}`;
}

// ---------------------------------------------------------------------------
// Other injected ports (contracts spec §3.6) — defined in shared,
// implemented per platform.
// ---------------------------------------------------------------------------

/** Auth-token port; refresh rotation is the auth spec's concern. */
export interface TokenProvider {
  getAccessToken(): Promise<string | null>;
}

/** Clock port — inject instead of reading the system clock in shared logic. */
export interface Clock {
  now(): Date;
}

/** Id-generation port (e.g. client-generated `PackingItem.id`s). */
export interface IdGenerator {
  generate(): string;
}
