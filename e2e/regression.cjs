// Consolidated browser regression suite for GeoMind AI (Milestones 4–8).
// Run through ./run.sh, which starts deterministic fake Overpass and LLM
// servers. External tile and geocoding requests are intercepted, so no
// test depends on the network. Waits are state-based (no fixed sleeps).
const fs = require("fs");
const { chromium } = require("playwright-core");

const WEB = process.env.E2E_WEB || "http://localhost:5174";
const OVERPASS = process.env.E2E_OVERPASS || "http://127.0.0.1:9100";
const LLM = process.env.E2E_LLM || "http://127.0.0.1:9101";
const CHROME = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const TIMEOUT = 60000;

// 1x1 transparent PNG for intercepted basemap tiles.
const TILE = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
);

const results = [];
function check(condition, message) {
  if (!condition) throw new Error(message);
}

async function journey(name, fn) {
  const started = Date.now();
  try {
    await fn();
    results.push({ name, ok: true });
    process.stdout.write(`PASS ${name} (${((Date.now() - started) / 1000).toFixed(1)}s)\n`);
  } catch (error) {
    results.push({ name, ok: false });
    process.stdout.write(`FAIL ${name} — ${error.message.split("\n")[0]}\n`);
  }
}

const setMode = (base, mode) => fetch(`${base}/mode/${mode}`);

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  const page = await context.newPage();
  page.setDefaultTimeout(TIMEOUT);

  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  page.on("console", (message) => {
    if (message.type() === "error" && !message.location().url.includes("favicon")) errors.push(message.text());
  });

  const tiles = [];
  const external = [];
  await page.route(
    (url) => !["localhost", "127.0.0.1"].includes(url.hostname),
    (route) => {
      const url = route.request().url();
      if (url.includes("basemaps.cartocdn.com")) {
        tiles.push(url);
        return route.fulfill({ status: 200, contentType: "image/png", body: TILE });
      }
      if (url.includes("fonts.googleapis.com")) {
        // Web font stylesheet: serve empty CSS so the run stays offline.
        return route.fulfill({ status: 200, contentType: "text/css", body: "" });
      }
      external.push(url);
      return route.abort();
    },
  );

  await setMode(OVERPASS, "normal");
  await setMode(LLM, "normal");

  const sidebar = (name) => page.getByRole("button", { name, exact: true }).first();
  const closePanel = (title) => page.getByRole("button", { name: `Close ${title}` }).click();
  const lastTurn = () => page.locator("article").last();
  const viewport = page.locator(".ol-viewport").first();
  const centre = { x: 720, y: 450 };

  async function ask(question) {
    await page.locator("#research-question").fill(question);
    await page.locator("#research-question").press("Enter");
    return lastTurn();
  }

  async function addAllLayers(turn) {
    const buttons = turn.getByRole("button", { name: /^Add to map/ });
    const count = await buttons.count();
    for (let i = 0; i < count; i++) await buttons.first().click();
    await turn.getByRole("button", { name: /^Added/ }).nth(count - 1).waitFor();
    return count;
  }

  async function mapImage() {
    return viewport.screenshot();
  }

  await journey("1. Open the application and load the map", async () => {
    await page.goto(WEB, { timeout: TIMEOUT });
    await page.locator(".ol-viewport canvas").first().waitFor();
    await page.getByText("GeoMind", { exact: false }).first().waitFor();
    await page.waitForFunction(() => document.querySelectorAll(".ol-layer canvas, .ol-viewport canvas").length > 0);
    check(tiles.length > 0, "no basemap tiles were requested");
  });

  await journey("2. Change map base layers", async () => {
    await sidebar("Map Settings").click();
    const baseMap = page.getByLabel("Show base map");
    await baseMap.uncheck();
    check(!(await baseMap.isChecked()), "base map did not hide");
    await baseMap.check();
    // Light and dark basemaps follow the theme.
    check(tiles.some((url) => url.includes("/dark_all/")), "dark theme did not load the dark basemap");
    const before = tiles.length;
    await page.getByRole("button", { name: "light", exact: true }).click();
    await page.waitForFunction(() => !document.documentElement.classList.contains("dark"));
    await waitUntil(() => tiles.slice(before).some((url) => url.includes("/light_all/")), "light basemap tiles");
    // Dark tiles are already cached by OpenLayers, so switching back makes no new requests.
    await page.getByRole("button", { name: "dark", exact: true }).click();
    await page.waitForFunction(() => document.documentElement.classList.contains("dark"));
    await closePanel("Map Settings");
  });

  await journey("3. Draw and select map features", async () => {
    await page.getByRole("button", { name: "Draw point" }).click();
    await page.mouse.click(centre.x, centre.y);
    await page.getByRole("button", { name: "Draw polygon" }).click();
    await page.mouse.click(820, 380);
    await page.mouse.click(960, 380);
    await page.mouse.click(960, 520);
    await page.mouse.dblclick(820, 520);
    await page.getByRole("button", { name: "Navigation mode" }).click();

    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "Export drawings as GeoJSON" }).click();
    const drawn = JSON.parse(fs.readFileSync(await (await download).path(), "utf8"));
    const types = drawn.features.map((f) => f.geometry.type).sort();
    check(JSON.stringify(types) === JSON.stringify(["Point", "Polygon"]), `drawn: ${types}`);
  });

  await journey("4. Open the feature inspector", async () => {
    await page.mouse.click(centre.x, centre.y);
    const inspector = page.getByText("Feature Inspector");
    await inspector.waitFor();
    await page.getByRole("button", { name: "Close inspector" }).click();
    await inspector.waitFor({ state: "detached" });

    await page.mouse.click(900, 460);
    await inspector.waitFor();
    await page.getByText("Geodesic area (server)").waitFor();
    await page.getByRole("button", { name: "Close inspector" }).click();
  });

  await journey("5. Discover geographical features", async () => {
    await sidebar("Discovery").click();
    await page.getByRole("button", { name: "Use current map centre" }).click();
    await page.getByRole("button", { name: "Discover Features" }).click();
    await page.getByRole("button", { name: "Zoom to results" }).waitFor();
    await closePanel("Discovery");
  });

  await journey("6. Run an AI research query (fake LLM)", async () => {
    await sidebar("Ask AI").click();
    await page.getByText("Remote LLM · fake-model").waitFor();
    await page.getByRole("button", { name: "Use current map centre" }).click();
    const turn = await ask("Which healthcare facilities are around here?");
    await turn.getByText("Completed · LLM").waitFor();
    await turn.getByText("The fake model found hospitals").waitFor();
    check((await turn.getByRole("button", { name: /^Add to map/ }).count()) >= 1, "no discovery layer offered");
  });

  await journey("7. Cancel an active streaming request", async () => {
    await setMode(LLM, "slow");
    try {
      const turn = await ask("Tell me about clinics around here");
      await turn.getByText("Thinking…").waitFor(); // loading state
      await page.getByRole("button", { name: "Cancel", exact: true }).click();
      await turn.getByText("Cancelled").waitFor();
      await page.locator("#research-question").fill("ready?");
      check(await page.getByRole("button", { name: "Ask", exact: true }).isEnabled(), "panel stayed busy after cancel");
      await page.locator("#research-question").fill("");
    } finally {
      await setMode(LLM, "normal");
    }
  });

  await journey("8. Run the hospital–pharmacy workflow", async () => {
    const turn = await ask("Find hospitals within 5 km and identify which hospitals have the most pharmacies within 1 km");
    const ranking = turn.getByRole("region", { name: "Ranking" });
    await ranking.waitFor();
    check((await ranking.locator("ol > li").count()) === 3, "expected 3 ranked hospitals");
    await turn.getByText("Completed · workflow (no LLM)").waitFor();
  });

  await journey("9. Run service coverage analysis (success and failure)", async () => {
    let turn = await ask("Identify areas within 5 km that are underserved by hospitals");
    await turn.getByRole("region", { name: "Coverage summary" }).waitFor();
    check((await addAllLayers(turn)) === 2, "expected coverage + services layers");

    await setMode(OVERPASS, "fail_all");
    try {
      turn = await ask("Identify areas within 5 km that are underserved by hospitals");
      await turn.getByText("The workflow did not complete").waitFor();
      check((await turn.getByRole("button", { name: /^Add to map/ }).count()) === 0, "failed run offered layers");
    } finally {
      await setMode(OVERPASS, "normal");
    }
  });

  await journey("10. Compare two geographical areas", async () => {
    await page.getByText("Compare with a second area").click();
    await page.getByRole("button", { name: "Pick area b on map" }).click();
    await page.mouse.click(600, 300);
    await page.getByText("Area B set").waitFor();
    const turn = await ask("Compare hospital coverage in these two areas");
    const comparison = turn.getByRole("region", { name: "Area comparison" });
    await comparison.waitFor();
    check((await comparison.getByText("Not analysed").count()) === 0, "an area was not analysed");
    await turn.getByText("No overall winner").waitFor();
  });

  await journey("11. Configure and run site suitability (complete and partial)", async () => {
    await page.getByText("Site suitability settings").click();
    await page.getByLabel("Facility").waitFor();
    const share = (id) => page.getByTestId(`share-${id}`).innerText();
    check((await share("distance_existing")) === "35%", "default weight not shown");
    const run = page.getByRole("button", { name: "Run suitability analysis" });
    await page.getByLabel("Use Distance to nearest pharmacy").check();
    check(await run.isDisabled(), "pharmacy direction not enforced");
    await page.getByLabel("Pharmacy direction").selectOption("closer");
    check(await run.isEnabled(), "run blocked after choosing direction");
    await page.getByLabel("Use Distance to nearest pharmacy").uncheck();
    await page.getByLabel("Weight for Distance to nearest existing hospital").fill("70");
    check((await share("distance_existing")) === "52%", "weights not renormalised");
    await page.getByRole("button", { name: "Defaults" }).click();
    check((await share("distance_existing")) === "35%", "defaults not restored");

    await run.click();
    const turn = lastTurn();
    await turn.getByText("Highest-scoring analytical candidate").first().waitFor();
    await turn.getByText("Completed · workflow (no LLM)").waitFor();
    check((await turn.getByRole("region", { name: "Top candidates" }).locator("ol > li").count()) === 10, "top 10 not listed");

    await setMode(OVERPASS, "fail_context");
    try {
      const partial = await ask("Rank the best locations for a hospital");
      await partial.getByText("Completed · partial results").waitFor();
      check((await partial.getByText("· unavailable").count()) >= 1, "unavailable criterion not shown");
    } finally {
      await setMode(OVERPASS, "normal");
    }
  });

  await journey("12. Select candidate points and compare them", async () => {
    const turn = page.locator("article").filter({ has: page.getByRole("region", { name: "Top candidates" }) }).first();
    const rows = turn.getByRole("region", { name: "Top candidates" }).locator("ol > li");
    await rows.first().locator("summary").click();
    await turn.getByRole("table", { name: /Score breakdown for c-/ }).first().waitFor();
    const comparison = turn.getByRole("region", { name: "Candidate comparison" });
    await rows.nth(4).getByRole("checkbox").check();
    const picked = (await rows.nth(4).locator("summary span.font-mono").nth(1).innerText()).trim();
    const headers = await comparison.locator("thead th").allInnerTexts();
    check(headers.includes(picked), `comparison headers ${headers.join("|")} miss ${picked}`);
  });

  await journey("13. Add analysis results to the map", async () => {
    const turn = page.locator("article").filter({ has: page.getByRole("region", { name: "Top candidates" }) }).first();
    check((await addAllLayers(turn)) === 3, "expected cells, points and existing facilities");
    await page.getByRole("button", { name: "Close research panel" }).click();
  });

  await journey("14. Toggle, zoom to, export and remove generated layers", async () => {
    await sidebar("Data Layers").click();
    const name = "Hospital suitability · 5 km · candidate points";
    const entry = page.locator("div.rounded-xl", { has: page.getByRole("button", { name: `Zoom to ${name}` }) }).last();
    await entry.waitFor();

    await entry.getByRole("button", { name: "Hide layer" }).click();
    await entry.getByRole("button", { name: "Show layer" }).click();
    await entry.getByRole("button", { name: "Hide layer" }).waitFor();

    await page.getByRole("button", { name: "Reset map view" }).click();
    const before = await mapImage();
    await entry.getByRole("button", { name: `Zoom to ${name}` }).click();
    await waitUntilAsync(async () => !(await mapImage()).equals(before), "map view did not change on zoom");

    const download = page.waitForEvent("download");
    await entry.getByRole("button", { name: `Export ${name} as GeoJSON` }).click();
    const exported = JSON.parse(fs.readFileSync(await (await download).path(), "utf8"));
    check(exported.type === "FeatureCollection" && exported.features.length > 0, "export is not GeoJSON");
    check(exported.features.every((f) => f.geometry.type === "Point" && "suitability_score" in f.properties), "export lost properties");

    await entry.getByRole("button", { name: `Remove ${name}` }).click();
    await page.getByRole("button", { name: `Zoom to ${name}` }).waitFor({ state: "detached" });
    await closePanel("Data Layers");
  });

  await journey("15. Dark and light themes", async () => {
    await sidebar("Map Settings").click();
    const background = () => page.evaluate(() => getComputedStyle(document.querySelector("main")).backgroundColor);
    await page.getByRole("button", { name: "light", exact: true }).click();
    await page.waitForFunction(() => !document.documentElement.classList.contains("dark"));
    check((await background()) === "rgb(255, 255, 255)", `light background ${await background()}`);
    await page.getByRole("button", { name: "dark", exact: true }).click();
    await page.waitForFunction(() => document.documentElement.classList.contains("dark"));
    check((await background()) === "rgb(0, 0, 0)", `dark background ${await background()}`);
    await closePanel("Map Settings");
  });

  await journey("Phone width has no horizontal scroll", async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    check(overflow <= 0, `overflow ${overflow}px`);
  });

  await journey("No console or page errors", async () => {
    check(errors.length === 0, errors.slice(0, 3).join(" | ") + ` (blocked external: ${[...new Set(external)].join(", ")})`);
  });

  await browser.close();
  const failed = results.filter((r) => !r.ok).length;
  process.stdout.write(`\n${results.length - failed}/${results.length} journeys passed\n`);
  process.exit(failed ? 1 : 0);
})().catch((error) => {
  process.stdout.write(`ERROR ${error.message}\n`);
  process.exit(1);
});

// State-based polling helpers (bounded; no fixed sleeps in journeys).
async function waitUntil(predicate, what, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function waitUntilAsync(predicate, what, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await predicate()) return;
  }
  throw new Error(`timed out: ${what}`);
}
