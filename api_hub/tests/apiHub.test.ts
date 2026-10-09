import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ApiAdapterRegistry } from "../adapterRegistry";
import { executeVerifiedAdapter, verifyAdapterAgainstFixture } from "../adapterExecutor";
import { parsePublicApisMarkdown } from "../catalogueImporter";
import { ApiCapabilityRegistry } from "../registry";
import { ApiHubService } from "../service";
import { builtInAdapters } from "../builtInAdapters";

const FIXTURE = `
### Animals
API | Description | Auth | HTTPS | CORS
|:---|:---|:---|:---|:---|
| [Cat Facts](https://catfact.ninja/) | Random cat facts | No | Yes | Yes |
| [Cats duplicate](https://catfact.ninja) | Duplicate URL | No | Yes | No |
| [Petfinder](https://www.petfinder.com/developers/) | Pet adoption | \`apiKey\` | Yes | Yes |

### Weather
API | Description | Auth | HTTPS | CORS |
|:---|:---|:---|:---|:---|
| [Open-Meteo](https://open-meteo.com/en/docs) | Weather forecasts and temperature | No | Yes | Yes |
| [Legacy Weather](http://legacy.example.com/docs) | Old forecast API | No | No | Unknown |
`;

test("public-apis importer parses fields, status and duplicates", () => {
  const parsed = parsePublicApisMarkdown(FIXTURE, "fixture");
  assert.equal(parsed.providers.length, 4);
  assert.equal(parsed.duplicates, 1);
  assert.equal(parsed.providers[0].status, "READY_NO_AUTH");
  assert.equal(parsed.providers[1].status, "NEEDS_API_KEY");
  assert.equal(parsed.providers[3].status, "UNSUPPORTED");
});

test("capability registry persists and ranks relevant ready providers", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "abxag-api-registry-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "providers.json");
  const registry = new ApiCapabilityRegistry(file, "fixture");
  await registry.initialize();
  await registry.import(parsePublicApisMarkdown(FIXTURE, "fixture"));
  const result = registry.search("Will it rain? weather forecast", { readyOnly: true });
  assert.equal(result[0].provider.name, "Open-Meteo");
  assert.equal(registry.summary().providerCount, 4);

  const reloaded = new ApiCapabilityRegistry(file, "fixture");
  await reloaded.initialize();
  assert.equal(reloaded.search("cat facts")[0].provider.name, "Cat Facts");
});

test("API hub sync validates and caches the upstream catalogue", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "abxag-api-service-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  let calls = 0;
  const service = new ApiHubService({
    dataDir: dir,
    sourceUrl: "https://catalogue.example.test/README.md",
    minimumProviderCount: 1,
    maximumAgeMs: 60_000,
    fetcher: async () => {
      calls += 1;
      return new Response(FIXTURE, { status: 200, headers: { etag: "fixture-v1" } });
    },
  });
  await service.initialize();
  const first = await service.sync();
  const cached = await service.sync();
  assert.equal(first.providerCount, 4);
  assert.equal(cached.providerCount, 4);
  assert.equal(calls, 1);
});

test("adapter registry rejects code-like or unverified adapters", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "abxag-adapters-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const registry = new ApiAdapterRegistry(path.join(dir, "adapters.json"));
  await registry.initialize();
  const adapter = {
    id: "weather.open-meteo.v1",
    providerId: "public-apis:weather",
    capability: "weather.forecast",
    method: "GET" as const,
    urlTemplate: "https://api.open-meteo.com/v1/forecast",
    parameters: [{ name: "latitude", in: "query" as const, required: true }],
    output: { temperature: ".current.temperature_2m" },
    verified: false,
    verifiedAt: null,
    verificationNotes: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await assert.rejects(() => registry.save(adapter), /Only adapters verified/);
  await assert.rejects(() => registry.save({
    ...adapter,
    verified: true,
    verifiedAt: new Date().toISOString(),
    urlTemplate: "file:///C:/secrets.txt",
  }), /safe public HTTP/);
});

test("verified declarative adapters normalize JSON without executing code", async () => {
  const timestamp = new Date().toISOString();
  const candidate = {
    id: "weather.fixture.v1",
    providerId: "public-apis:weather",
    capability: "weather.current",
    method: "GET" as const,
    urlTemplate: "https://weather.example.test/current",
    parameters: [{ name: "city", in: "query" as const, required: true }],
    output: { temperature: ".current.temperature", condition: ".current.condition" },
    verified: false,
    verifiedAt: null,
    verificationNotes: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const fixture = { current: { temperature: 24, condition: "clear" } };
  const adapter = verifyAdapterAgainstFixture(candidate, fixture);
  const result = await executeVerifiedAdapter(adapter, { city: "Pune" }, {
    fetcher: async (input) => {
      assert.match(String(input), /city=Pune/);
      return new Response(JSON.stringify(fixture), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  assert.deepEqual(result.data, { temperature: 24, condition: "clear" });
  await assert.rejects(() => executeVerifiedAdapter(adapter, { city: "Pune", injected: "x" }, {
    fetcher: async () => new Response("{}"),
  }), /Unknown adapter parameter/);
});

test("built-in adapters expose only fixture-verified normalized capabilities", () => {
  const adapters = builtInAdapters();
  assert.deepEqual(adapters.map((adapter) => adapter.id), [
    "weather.open-meteo.current.v1",
    "currency.frankfurter.rate.v2",
    "space.launch-library.upcoming.v1",
  ]);
  assert.equal(adapters.every((adapter) => adapter.verified && Boolean(adapter.verifiedAt)), true);
  const currency = adapters.find((adapter) => adapter.id === "currency.frankfurter.rate.v2");
  assert.equal(currency?.capability, "currency.exchange_rate");
  assert.equal(currency?.output.rate, ".rate");
});

