import { assert, assertEquals, assertRejects } from "@std/assert";
import { fromFileUrl } from "@std/path";
import type { Json, RunInput } from "@shared/core";
import { directTransport, Engine } from "@monid/connector-engine";
import {
    type Fixture,
    loadFixture,
    replayFetch,
    runEndpoint,
    testBundle,
    testSealedUnit,
} from "@shared/testing";

const FIXTURES = fromFileUrl(new URL("./fixtures/", import.meta.url));
const MCP_URL = "https://mcp.dimhour.com/mcp";

/**
 * The nine public read tools, as their stable Monid identities. Each row
 * pins the FIXED MCP tool name its toRequest must send, one small input,
 * and the recorded chain it replays. Written as LITERALS on purpose: a
 * table derived from the docs would make the request test a tautology.
 * Every `limit` here is 2 or less (see the bulk-safety test).
 */
const ENDPOINTS: Record<
    string,
    { tool: string; input: RunInput; fixture: string }
> = {
    "dimhour#list-cities": {
        tool: "list_cities",
        input: {},
        fixture: "list-cities-ok",
    },
    "dimhour#search-venues": {
        tool: "search_venues",
        input: { body: { city: "dallas", query: "ramen", limit: 2 } },
        fixture: "search-venues-ok",
    },
    "dimhour#get-venue": {
        tool: "get_venue",
        input: { body: { city: "dallas", name: "Las Palmas" } },
        fixture: "get-venue-ok",
    },
    "dimhour#list-new-venues": {
        tool: "list_new_venues",
        input: { body: { city: "dallas", days: 30, limit: 2 } },
        fixture: "list-new-venues-ok",
    },
    "dimhour#list-curated": {
        tool: "list_curated",
        input: { body: { city: "dallas" } },
        fixture: "list-curated-ok",
    },
    "dimhour#find-places": {
        tool: "find_places",
        input: { body: { city: "dallas", looking_for: "patio", limit: 2 } },
        fixture: "find-places-ok",
    },
    "dimhour#get-hours": {
        tool: "get_hours",
        input: { body: { city: "dallas", name: "Las Palmas" } },
        fixture: "get-hours-ok",
    },
    "dimhour#search": {
        tool: "search",
        input: { body: { query: "ramen dallas" } },
        fixture: "search-ok",
    },
    "dimhour#fetch": {
        tool: "fetch",
        input: { body: { id: "dallas:393" } },
        fixture: "fetch-ok",
    },
};
const IDS = Object.keys(ENDPOINTS);

const fixture = (name: string) => loadFixture(`${FIXTURES}${name}.json`);

const ONE_CALL = { credits: { default: 1 }, evidence: { CALL: 1 } };
const ZERO = { credits: {}, evidence: {} };

/** The recorded MCP envelope's structuredContent — what the caller gets. */
const structuredOf = (
    f: Fixture,
): Json => ((f.calls[0].res.body as { result: { structuredContent: Json } })
    .result.structuredContent);

/** Run one endpoint through the real engine with a fetch that records
 *  what went on the wire, then replays the chain. */
async function captureRun(
    id: string,
    input: RunInput,
    chain: Fixture,
    params: Record<string, string> = {},
) {
    const sent: {
        url: string;
        method: string;
        headers: Headers;
        body: Json;
    }[] = [];
    const replay = replayFetch(chain, { "request.url": MCP_URL });
    const loaded = await new Engine({
        transport: directTransport({
            params: () => Promise.resolve(params),
            fetch: (url, init) => {
                sent.push({
                    url: String(url),
                    method: init?.method ?? "GET",
                    headers: new Headers(init?.headers),
                    body: JSON.parse(String(init?.body)),
                });
                return replay(url, init);
            },
        }),
    }).load(await testSealedUnit(id));
    const result = await loaded.run(input);
    return { sent, result };
}

for (const id of IDS) {
    const row = ENDPOINTS[id];

    Deno.test(`${id} happy: structuredContent comes back without the MCP envelope, one call billed`, async () => {
        const chain = await fixture(row.fixture);
        const result = await runEndpoint({
            unit: await testSealedUnit(id),
            input: row.input,
            mode: "replay",
            fixture: chain,
        });
        assertEquals(result.httpStatus, 200);
        assertEquals(result.isProviderError, false);
        assertEquals(result.usage, ONE_CALL);
        assertEquals(result.output, structuredOf(chain));
        const out = result.output as Record<string, unknown>;
        for (const envelopeKey of ["jsonrpc", "result", "content"]) {
            assert(!(envelopeKey in out), `${envelopeKey} leaked`);
        }
    });

    Deno.test(`${id} request: POST /mcp, tools/call "${row.tool}", the input as params.arguments`, async () => {
        const { sent } = await captureRun(
            id,
            row.input,
            await fixture(row.fixture),
        );
        assertEquals(sent.length, 1);
        assertEquals(sent[0].url, MCP_URL);
        assertEquals(sent[0].method, "POST");
        assertEquals(sent[0].body, {
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: { name: row.tool, arguments: row.input.body ?? {} },
        });
        assertEquals(sent[0].headers.get("content-type"), "application/json");
        assertEquals(
            sent[0].headers.get("accept"),
            "application/json, text/event-stream",
        );
    });

    Deno.test(`${id} JSON-RPC top-level error in a 200: a 502 provider error, zero usage`, async () => {
        const result = await runEndpoint({
            unit: await testSealedUnit(id),
            input: row.input,
            mode: "replay",
            fixture: await fixture("rpc-error"),
        });
        assertEquals(result.httpStatus, 502);
        assertEquals(result.providerHttpStatus, 200);
        assertEquals(result.isProviderError, true);
        assertEquals(result.usage, ZERO);
        const out = result.output as Record<string, unknown>;
        assertEquals(out.message, "Method not found");
        assertEquals(out.error_code, -32601);
        assert(out.raw !== undefined, "raw body rides along");
    });

    Deno.test(`${id} result.isError in a 200: a 502 provider error, zero usage`, async () => {
        const result = await runEndpoint({
            unit: await testSealedUnit(id),
            input: row.input,
            mode: "replay",
            fixture: await fixture("tool-error"),
        });
        assertEquals(result.httpStatus, 502);
        assertEquals(result.providerHttpStatus, 200);
        assertEquals(result.isProviderError, true);
        assertEquals(result.usage, ZERO);
        const out = result.output as Record<string, unknown>;
        assert(
            String(out.message).startsWith('Unknown city "atlantis"'),
            String(out.message),
        );
    });
}

Deno.test("dimhour vendor non-2xx (HTTP 400): provider error, zero usage", async () => {
    const result = await runEndpoint({
        unit: await testSealedUnit("dimhour#search"),
        input: ENDPOINTS["dimhour#search"].input,
        mode: "replay",
        fixture: await fixture("http-error"),
    });
    assertEquals(result.httpStatus, 400);
    assertEquals(result.isProviderError, true);
    assertEquals(result.usage, ZERO);
    assertEquals(
        (result.output as Record<string, unknown>).message,
        "Parse error: body must be JSON-RPC 2.0",
    );
});

Deno.test("dimhour output: structuredContent wins over a differing text block", async () => {
    const chain = await fixture("synthetic-structured-preferred");
    const result = await runEndpoint({
        unit: await testSealedUnit("dimhour#get-hours"),
        input: ENDPOINTS["dimhour#get-hours"].input,
        mode: "replay",
        fixture: chain,
    });
    assertEquals(result.isProviderError, false);
    assertEquals(result.usage, ONE_CALL);
    assertEquals(result.output, structuredOf(chain));
});

Deno.test("dimhour fallback: JSON in content[0].text is parsed when structuredContent is absent", async () => {
    const chain = await fixture("synthetic-text-fallback");
    const result = await runEndpoint({
        unit: await testSealedUnit("dimhour#get-hours"),
        input: ENDPOINTS["dimhour#get-hours"].input,
        mode: "replay",
        fixture: chain,
    });
    assertEquals(result.httpStatus, 200);
    assertEquals(result.isProviderError, false);
    assertEquals(result.usage, ONE_CALL);
    const text = (chain.calls[0].res.body as {
        result: { content: { text: string }[] };
    }).result.content[0].text;
    assertEquals(result.output, JSON.parse(text));
    // and it is the same payload the structured twin carries
    assertEquals(result.output, structuredOf(await fixture("get-hours-ok")));
});

Deno.test("dimhour defensive: non-JSON text never settles as a successful structured result", async () => {
    const chain = await fixture("synthetic-text-malformed");
    const result = await runEndpoint({
        unit: await testSealedUnit("dimhour#search-venues"),
        input: ENDPOINTS["dimhour#search-venues"].input,
        mode: "replay",
        fixture: chain,
    });
    assertEquals(result.httpStatus, 502);
    assertEquals(result.providerHttpStatus, 200);
    assertEquals(result.isProviderError, true);
    assertEquals(result.usage, ZERO);
    const out = result.output as Record<string, unknown>;
    assertEquals(
        out.message,
        "Dim Hour answered without structured JSON content",
    );
    assertEquals(out.raw, chain.calls[0].res.body);
});

Deno.test("dimhour identity: nine endpoints share POST /mcp and compile to unique stable ids", async () => {
    const bundle = await testBundle();
    const docs = Object.values(bundle.endpoints).filter((d) =>
        d.provider === "dimhour"
    );
    assertEquals(docs.map((d) => d.id).sort(), [...IDS].sort());
    for (const doc of docs) {
        assertEquals(doc.request.url, MCP_URL, doc.id);
        assertEquals(doc.request.method, "POST", doc.id);
        assertEquals(doc.id, `dimhour#${doc.endpoint.slice(1)}`);
    }
    // one shared transport path, nine distinct public identities
    assertEquals(new Set(docs.map((d) => d.request.url)).size, 1);
    assertEquals(new Set(docs.map((d) => d.endpoint)).size, IDS.length);
    // the classification is ONE provider fn every endpoint links to
    const starts = new Set(
        docs.map((d) => JSON.stringify(d.lifecycle?.start)),
    );
    assertEquals(starts.size, 1);
});

Deno.test("dimhour auth: reads go out with no key; a configured key travels as x-api-key", async () => {
    const id = "dimhour#list-cities";
    const chain = await fixture("list-cities-ok");
    const bare = await captureRun(id, {}, chain);
    assertEquals(bare.result.isProviderError, false);
    assertEquals(bare.sent[0].headers.get("x-api-key"), null);
    assertEquals(bare.sent[0].headers.get("authorization"), null);
    const keyed = await captureRun(id, {}, chain, { apiKey: "test-key" });
    assertEquals(keyed.sent[0].headers.get("x-api-key"), "test-key");
});

Deno.test("dimhour schema gate: the source's own bounds and required fields", async () => {
    const run = async (id: string, body: Record<string, Json>) =>
        runEndpoint({
            unit: await testSealedUnit(id),
            input: { body },
            mode: "replay",
            fixture: await fixture(ENDPOINTS[id].fixture),
        });
    const rejected: [string, Record<string, Json>][] = [
        ["dimhour#search-venues", { city: "dallas", limit: 26 }],
        ["dimhour#search-venues", { limit: 0 }],
        ["dimhour#search-venues", { max_price: 5 }],
        ["dimhour#search-venues", { sort: "random" }],
        ["dimhour#search-venues", { bulk: true }],
        ["dimhour#find-places", { city: "dallas", limit: 26 }],
        ["dimhour#find-places", { looking_for: "patio" }],
        ["dimhour#list-new-venues", { days: 91 }],
        ["dimhour#list-new-venues", { limit: 101 }],
        ["dimhour#get-venue", { id: 28 }],
        ["dimhour#get-venue", { city: "dallas", id: 1.5 }],
        ["dimhour#get-hours", { name: "Las Palmas" }],
        ["dimhour#list-curated", { list_id: "x" }],
        ["dimhour#search", {}],
        ["dimhour#fetch", {}],
    ];
    for (const [id, body] of rejected) {
        await assertRejects(
            () => run(id, body),
            Error,
            "INVALID_INPUT",
            `${id} ${JSON.stringify(body)}`,
        );
    }
});

Deno.test("dimhour bulk safety: every limit is bounded by the source and no test asks for more than 2", async () => {
    const bundle = await testBundle();
    const bounds: Record<string, number> = {};
    for (const doc of Object.values(bundle.endpoints)) {
        if (doc.provider !== "dimhour") continue;
        const props = (doc.input.schema?.body?.properties ?? {}) as Record<
            string,
            { maximum?: number }
        >;
        if (props.limit) bounds[doc.id] = props.limit.maximum ?? Infinity;
    }
    assertEquals(bounds, {
        "dimhour#search-venues": 25,
        "dimhour#find-places": 25,
        "dimhour#list-new-venues": 100,
    });
    for (const [id, row] of Object.entries(ENDPOINTS)) {
        const limit = (row.input.body as { limit?: number } | undefined)
            ?.limit;
        assert(limit === undefined || limit <= 2, `${id} asks for ${limit}`);
    }
});

Deno.test("dimhour estimate: one call, promised without IO", async () => {
    for (const id of IDS) {
        const loaded = await new Engine({
            transport: directTransport({
                params: () => Promise.resolve({}),
                fetch: () =>
                    Promise.reject(new Error("estimate must not do IO")),
            }),
        }).load(await testSealedUnit(id));
        assertEquals(await loaded.estimate(ENDPOINTS[id].input), ONE_CALL);
    }
});

/**
 * LIVE smoke — opt-in, credential-free: `DIMHOUR_LIVE=1 deno task
 * test:live connectors/dimhour`. One small request per endpoint (every
 * limit ≤ 2), nine calls in all, well inside the anonymous daily cap.
 * Gated on an explicit flag rather than a credential because reads need
 * none, so a credential gate would never skip.
 */
Deno.test({
    name: "dimhour live smoke (opt-in: DIMHOUR_LIVE=1)",
    ignore: Deno.env.get("DIMHOUR_LIVE") !== "1",
    fn: async () => {
        for (const id of IDS) {
            const result = await runEndpoint({
                unit: await testSealedUnit(id),
                input: ENDPOINTS[id].input,
                mode: "live",
            });
            assertEquals(
                result.isProviderError,
                false,
                `${id}: ${JSON.stringify(result.output).slice(0, 300)}`,
            );
            assertEquals(result.usage, ONE_CALL, id);
            const out = result.output as Record<string, unknown>;
            assert(!("jsonrpc" in out), `${id}: envelope leaked`);
        }
    },
});
