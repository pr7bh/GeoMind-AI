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
let currentPage = null;
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
    if (currentPage) {
      const shot = require("path").join(require("os").tmpdir(), `geomind-e2e-${results.length}.png`);
      await currentPage.screenshot({ path: shot }).catch(() => {});
      process.stdout.write(`     screenshot: ${shot}\n`);
    }
  }
}

const setMode = (base, mode) => fetch(`${base}/mode/${mode}`);

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  const page = await context.newPage();
  page.setDefaultTimeout(TIMEOUT);
  currentPage = page;

  const errors = [];
  // Set while a journey deliberately simulates a failing endpoint.
  let expectedFailureUrl = null;
  page.on("pageerror", (error) => errors.push(String(error)));
  page.on("console", (message) => {
    const url = message.location().url;
    if (message.type() !== "error" || url.includes("favicon")) return;
    if (expectedFailureUrl && url.includes(expectedFailureUrl)) return;
    errors.push(message.text());
  });

  const tiles = [];
  const external = [];
  await page.route(
    (url) => !["localhost", "127.0.0.1"].includes(url.hostname),
    (route) => {
      const url = route.request().url();
      if (url.includes("basemaps.cartocdn.com") || url.includes("tile.openstreetmap.org")) {
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

  // Milestone 9.1: research planning (plan only, nothing executed).
  const overpassCount = async () => Number(await (await fetch(`${OVERPASS}/count`)).text());
  const plan = async (question) => {
    await page.locator("#research-question").fill(question);
    await page.getByRole("button", { name: "Plan Research" }).click();
    return lastTurn();
  };

  await journey("16. Plan research without executing it", async () => {
    await sidebar("Ask AI").click();
    await page.getByRole("button", { name: "Use current map centre" }).click();
    const before = await overpassCount();
    const executions = [];
    const onRequest = (request) => request.url().includes("/api/agent/chat") && executions.push(request.url());
    page.on("request", onRequest);
    try {
      const turn = await plan("Identify areas with poor hospital coverage around this location");
      await turn.getByText("Research plan created · not executed").waitFor();
      await turn.getByText("Ready to execute").waitFor();
      const steps = turn.getByRole("list", { name: "Planned steps" }).locator(":scope > li");
      check((await steps.count()) === 3, "expected 3 planned steps");
      check((await steps.nth(0).getAttribute("data-status")) === "ready", "first step should be ready");
      await steps.nth(1).getByText("after #1").waitFor(); // dependency display
      await steps.nth(2).getByText("Identify underserved cells").waitFor();
      check((await turn.getByRole("button", { name: /^Add to map/ }).count()) === 0, "planning produced layers");
    } finally {
      page.off("request", onRequest);
    }
    check(executions.length === 0, "planning called the execution endpoint");
    check((await overpassCount()) === before, "planning queried Overpass");
  });

  await journey("17. Missing input, blocked steps, map selection and re-plan", async () => {
    const clearB = page.getByRole("button", { name: "Clear area b" });
    if (await clearB.count()) await clearB.click();
    const question = "Compare hospital accessibility between two areas, identify underserved locations, and recommend suitable locations for a new hospital";
    const turn = await plan(question);
    await turn.getByText("Needs input").waitFor();
    const missing = turn.getByRole("group", { name: "Missing inputs" });
    await missing.getByText("Second study area (Area B)").waitFor();
    check((await turn.locator('li[data-status="blocked"]').count()) >= 1, "no blocked steps shown");
    check((await turn.getByRole("list", { name: "Planned steps" }).locator(":scope > li").count()) === 8, "expected 8 steps");

    await missing.getByRole("button", { name: "Pick Area B" }).click();
    await page.mouse.click(600, 300);
    await page.getByText("Area B set").waitFor();
    await turn.getByRole("button", { name: "Plan again" }).click();
    const replanned = lastTurn();
    await replanned.getByText("Ready to execute").waitFor();
    check((await replanned.locator('li[data-status="blocked"]').count()) === 0, "steps still blocked after picking Area B");
  });

  await journey("18. Unsupported request and revising the question", async () => {
    const turn = await plan("What is the meaning of life?");
    await turn.getByText("Unsupported", { exact: true }).waitFor();
    await turn.getByText(/Find hospitals within 5 km/).waitFor();
    await turn.getByRole("button", { name: "Revise question" }).click();
    check((await page.locator("#research-question").inputValue()) === "What is the meaning of life?", "question not restored");
    await page.locator("#research-question").fill("");
  });

  await journey("19. Planning API failure is shown, not hidden", async () => {
    expectedFailureUrl = "/api/research/plan";
    await page.route("**/api/research/plan", (route) =>
      route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ detail: "Planner unavailable" }) }),
    );
    try {
      const turn = await plan("Find hospitals within 5 km");
      await turn.getByText("Planner unavailable").waitFor();
      await turn.getByText("Failed", { exact: true }).waitFor();
    } finally {
      await page.unroute("**/api/research/plan");
      expectedFailureUrl = null;
    }
    await page.getByRole("button", { name: "Close research panel" }).click();
  });

  // Milestone 9.2: approved execution of research plans.
  const executeTurn = async (question) => {
    const turn = await plan(question);
    await turn.getByText("Ready to execute").waitFor();
    return turn;
  };
  const stepStatuses = (turn) =>
    turn.getByRole("list", { name: "Planned steps" }).locator(":scope > li").evaluateAll((items) =>
      items.map((item) => item.getAttribute("data-execution-status")),
    );

  await journey("20. Explicit approval, progress and results", async () => {
    await sidebar("Ask AI").click();
    await page.getByRole("button", { name: "Use current map centre" }).click();
    // Earlier journeys leave the suitability settings open; give the conversation room.
    const settings = page.locator("details", { has: page.locator("summary", { hasText: "Site suitability settings" }) });
    if (await settings.evaluate((element) => element.open)) await settings.locator("summary").click();
    const turn = await executeTurn("Identify areas with poor hospital coverage around this location");
    const before = await overpassCount();
    check((await overpassCount()) === before, "planning queried Overpass");
    check((await stepStatuses(turn)).every((s) => s === null), "steps ran before approval");

    await turn.getByRole("button", { name: "Execute Research" }).click();
    await turn.getByText("Research executed", { exact: true }).waitFor();
    check(JSON.stringify(await stepStatuses(turn)) === JSON.stringify(["completed", "completed", "completed"]), "steps not completed");
    await turn.getByText("3 of 3 steps completed").waitFor();
    await turn.getByText("Plan approved").waitFor();
    const result = turn.getByRole("group", { name: "Service coverage analysis results" });
    await result.getByRole("region", { name: "Coverage summary" }).waitFor();
    check((await overpassCount()) === before + 1, "expected exactly one discovery request");
    check((await turn.getByRole("button", { name: "Execute Research" }).count()) === 0, "execute offered twice");
  });

  await journey("21. Add executed results to the map", async () => {
    const result = lastTurn().getByRole("group", { name: "Service coverage analysis results" });
    const buttons = result.getByRole("button", { name: /^Add to map/ });
    const count = await buttons.count();
    check(count === 2, `expected coverage + services layers, got ${count}`);
    for (let i = 0; i < count; i++) await buttons.first().click();
    await result.getByRole("button", { name: /^Added/ }).nth(1).waitFor();
  });

  await journey("22. Partial results when optional context fails", async () => {
    await setMode(OVERPASS, "fail_context");
    try {
      const turn = await executeTurn("Find suitable locations for a new hospital");
      await turn.getByRole("button", { name: "Execute Research" }).click();
      await turn.getByText("Research executed · partial results or warnings").waitFor();
      await turn.getByText("Partial results", { exact: true }).waitFor();
      const statuses = await stepStatuses(turn);
      check(statuses.includes("failed") && statuses.at(-1) === "completed", `statuses ${statuses}`);
      await turn.getByText("Highest-scoring analytical candidate").first().waitFor();
    } finally {
      await setMode(OVERPASS, "normal");
    }
  });

  await journey("23. Failed workflow is reported, not fabricated", async () => {
    await setMode(OVERPASS, "fail_all");
    try {
      const turn = await executeTurn("Identify areas with poor hospital coverage around this location");
      await turn.getByRole("button", { name: "Execute Research" }).click();
      await turn.getByText("Research execution failed").waitFor();
      check(JSON.stringify(await stepStatuses(turn)) === JSON.stringify(["failed", "blocked", "blocked"]), "wrong failure states");
      check((await turn.getByRole("button", { name: /^Add to map/ }).count()) === 0, "failed run offered layers");
    } finally {
      await setMode(OVERPASS, "normal");
    }
  });

  await journey("24. Multi-workflow execution reuses discovery", async () => {
    if ((await page.getByText("Area B set").count()) === 0) {
      await page.getByText("Compare with a second area").click();
      await page.getByRole("button", { name: "Pick area b on map" }).click();
      await page.mouse.click(600, 300);
      await page.getByText("Area B set").waitFor();
    }
    const before = await overpassCount();
    const turn = await executeTurn(
      "Compare hospital accessibility between two areas, identify underserved locations, and recommend suitable locations for a new hospital",
    );
    await turn.getByRole("button", { name: "Execute Research" }).click();
    await turn.getByText("Research executed", { exact: true }).waitFor();
    await turn.getByText("Reused result of #1 (no new request)").waitFor();
    check((await overpassCount()) - before === 3, `expected 3 requests, got ${(await overpassCount()) - before}`);
    await turn.getByRole("group", { name: "Area comparison results" }).getByRole("region", { name: "Area comparison" }).waitFor();
    await turn.getByRole("group", { name: "Site suitability (MCDA) results" }).getByText("Highest-scoring analytical candidate").first().waitFor();
  });

  await journey("25. Cancel research while a request is running", async () => {
    await setMode(OVERPASS, "slow");
    try {
      const turn = await executeTurn("Identify areas with poor hospital coverage around this location");
      await turn.getByRole("button", { name: "Execute Research" }).click();
      await turn.locator('li[data-execution-status="running"]').waitFor();
      await turn.getByRole("button", { name: "Cancel Research" }).click();
      await turn.getByText("Research cancelled · completed steps kept").waitFor();
      check((await stepStatuses(turn)).every((s) => s === "cancelled"), "steps not cancelled");
      check((await turn.getByRole("button", { name: /^Add to map/ }).count()) === 0, "cancelled run offered layers");
      await page.locator("#research-question").fill("ready?");
      check(await page.getByRole("button", { name: "Plan Research" }).isEnabled(), "panel stayed busy");
      await page.locator("#research-question").fill("");
    } finally {
      await setMode(OVERPASS, "normal");
    }
    await page.getByRole("button", { name: "Close research panel" }).click();
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
