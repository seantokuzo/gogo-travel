import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { ApiClient, EndpointDescriptor, InferInput, InferResponse } from "./descriptor.js";
import { descriptorKey } from "./descriptor.js";

const listBookings = {
  method: "GET",
  path: "/trips/:tripId/bookings",
  params: z.object({ tripId: z.uuid() }),
  query: z.object({ cursor: z.string().optional() }),
  response: z.object({ items: z.array(z.object({ id: z.string() })) }),
} satisfies EndpointDescriptor;

describe("descriptorKey", () => {
  it("is stable METHOD + path", () => {
    expect(descriptorKey(listBookings)).toBe("GET /trips/:tripId/bookings");
  });
});

describe("ApiClient DI seam (types only — compile-time contract)", () => {
  it("a conforming fake client satisfies the interface and round-trips", async () => {
    const fake: ApiClient = {
      request<D extends EndpointDescriptor>(descriptor: D, _input: InferInput<D>) {
        // Implementations must parse with descriptor.response before returning.
        return Promise.resolve(
          descriptor.response.parse({ items: [{ id: "b1" }] }) as InferResponse<D>,
        );
      },
    };

    const result = await fake.request(listBookings, {
      params: { tripId: "6f9d9d31-6d4a-4b7a-9df6-9b4a3f6d2e1c" },
      query: {},
    });

    // Compile-time: result.items is typed; runtime: parsed through the schema.
    expect(result.items[0]?.id).toBe("b1");
  });

  it("response parsing rejects wire drift", () => {
    expect(() => listBookings.response.parse({ items: [{ id: 42 }] })).toThrow();
  });
});
