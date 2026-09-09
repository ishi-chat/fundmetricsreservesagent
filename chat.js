// Vercel serverless function at repo root (chat.js), routed to POST /chat.
// The OpenAI key lives in the OPENAI_API_KEY env var and never reaches the browser.
// All arithmetic runs in runReservesCheck / runFundMetrics - deterministic,
// never left to the model.

const MODEL = process.env.MODEL || "gpt-5.6-luna";
const MAX_TURNS = 24; // max messages accepted from the client
const MAX_CHARS = 4000; // per message
const MAX_TOOL_LOOPS = 3;

const CONV_RANK = { Winner: 0, Core: 1, Watch: 2 };

const DEFAULT_BOOK = {
  fund: "Demo Fund V (synthetic - invented names, illustrative only)",
  committed: 350,
  fee_load: 25,
  companies: [
    { name: "Solace", cost: 28, nav: 62, conviction: "Winner" },
    { name: "Indigo", cost: 22, nav: 48, conviction: "Winner" },
    { name: "Northglass", cost: 18, nav: 41, conviction: "Winner" },
    { name: "Veda", cost: 20, nav: 28, conviction: "Core" },
    { name: "Kora", cost: 16, nav: 21, conviction: "Core" },
    { name: "Hale", cost: 12, nav: 15, conviction: "Core" },
    { name: "Lumen", cost: 14, nav: 11, conviction: "Watch" },
    { name: "Marlowe", cost: 10, nav: 8, conviction: "Watch" },
  ],
};

const SYSTEM_PROMPT = `You are a fund finance agent for venture and growth funds,
built as a public demo by Ishita Chaturvedi (CA, CFA) to show how fund finance
processes can be automated with deterministic controls. You cover two jobs:
reserves adequacy, and fund performance metrics with an IC note.

METHOD (never deviate, never do arithmetic yourself - always call a tool):
- Reserves: follow-on capacity = (committed - invested - remaining fee load)
  x follow-on policy %. Implied need per company = cost x reserve multiple by
  conviction (Winner 2.0x, Core 1.0x, Watch 0.25x by default). Coverage =
  capacity / total implied need. Below 1x, rank companies (conviction then
  MOIC by default) and allocate until capacity is gone. Partial fill still
  counts as crowded.
- Performance: DPI = distributed / paid-in. RVPI = NAV / paid-in.
  TVPI = DPI + RVPI always. IRR is XIRR on dated cashflows (calls negative,
  distributions positive, remaining NAV as terminal inflow).
- Inadequate reserves means the fund misses or shrinks the companies that
  drive returns. TVPI is paper; DPI is cash banked; IRR is speed.

BEHAVIOUR:
- Reserves questions or a portfolio book: call run_reserves_check.
- Performance, multiples, IRR, or an IC note: call run_fund_metrics.
  Report the eight_line_ic_note it returns, then add brief colour.
- Use tool numbers verbatim. If inputs are partial, use the defaults and say
  which values were assumed.
- Reserves report format: capacity bridge, coverage % with band
  (ADEQUATE >=100%, TIGHT 85-100%, SHORT <85%), fully reserved names,
  crowded names with shortfalls, one-sentence IC question, assumptions to challenge.
- Explain fund metrics (IRR, TVPI, DPI, RVPI, MOIC, dry powder, reserves)
  clearly when asked. Teach with small worked examples.
- Conviction labels are the investment team's input, not finance's:
  present them as scenario inputs to be challenged.

HARD LIMITS:
- The default book is synthetic. Never present it as any real fund's data.
- You have no data on Unilever Ventures or any actual fund's portfolio,
  marks, or reserves. If asked, say so and offer the synthetic demo instead.
- Never invent NAVs, costs, or valuations for real companies.
- This is a methodology demo, not investment advice.
- Politely decline topics unrelated to fund finance and reserves methodology.
- Keep answers under roughly 350 words unless the user asks for depth.`;

const TOOL_DEF = {
  type: "function",
  function: {
    name: "run_reserves_check",
    description:
      "Deterministically compute follow-on capacity vs implied reserve need and allocate capacity in rank order. Omit 'book' to use the built-in synthetic demo book.",
    parameters: {
      type: "object",
      properties: {
        book: {
          type: "object",
          properties: {
            fund: { type: "string" },
            committed: { type: "number" },
            fee_load: { type: "number" },
            companies: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  name: { type: "string" },
                  cost: { type: "number" },
                  nav: { type: "number" },
                  conviction: {
                    type: "string",
                    enum: ["Winner", "Core", "Watch"],
                  },
                },
                required: ["name", "cost", "nav", "conviction"],
              },
            },
          },
          required: ["committed", "companies"],
        },
        follow_on_pct: { type: "number", description: "default 70" },
        winner_x: { type: "number", description: "default 2.0" },
        core_x: { type: "number", description: "default 1.0" },
        watch_x: { type: "number", description: "default 0.25" },
        rank: {
          type: "string",
          enum: ["conviction-moic", "moic", "need"],
          description: "default conviction-moic",
        },
      },
    },
  },
};

function runReservesCheck(args) {
  const book = args.book || DEFAULT_BOOK;
  const followOnPct = args.follow_on_pct ?? 70;
  const multiples = {
    Winner: args.winner_x ?? 2.0,
    Core: args.core_x ?? 1.0,
    Watch: args.watch_x ?? 0.25,
  };
  const rankRule = args.rank || "conviction-moic";

  const companies = book.companies.map((c) => {
    const moic = c.cost ? c.nav / c.cost : 0;
    return { ...c, moic, need: c.cost * multiples[c.conviction] };
  });

  const invested = companies.reduce((s, c) => s + c.cost, 0);
  const dryPowder = book.committed - invested - (book.fee_load || 0);
  const capacity = (dryPowder * followOnPct) / 100;
  const implied = companies.reduce((s, c) => s + c.need, 0);
  const coverage = implied ? capacity / implied : null;

  const ranked = [...companies].sort((a, b) => {
    if (rankRule === "need") return b.need - a.need;
    if (rankRule === "moic") return b.moic - a.moic;
    const conv = CONV_RANK[a.conviction] - CONV_RANK[b.conviction];
    return conv !== 0 ? conv : b.moic - a.moic;
  });

  let remaining = capacity;
  const allocation = ranked.map((c) => {
    const allocated = Math.min(c.need, Math.max(0, remaining));
    remaining -= allocated;
    const shortfall = c.need - allocated;
    return {
      name: c.name,
      conviction: c.conviction,
      moic: Number(c.moic.toFixed(2)),
      need: Number(c.need.toFixed(1)),
      allocated: Number(allocated.toFixed(1)),
      shortfall: Number(shortfall.toFixed(1)),
      status:
        shortfall <= 0.05
          ? "fully reserved"
          : allocated > 0
            ? "partial - crowded"
            : "crowded out",
    };
  });

  return {
    fund: book.fund || "unnamed fund",
    committed: book.committed,
    invested: Number(invested.toFixed(1)),
    fee_load: book.fee_load || 0,
    dry_powder: Number(dryPowder.toFixed(1)),
    follow_on_pct: followOnPct,
    capacity: Number(capacity.toFixed(1)),
    implied_need: Number(implied.toFixed(1)),
    coverage_pct: coverage === null ? null : Number((coverage * 100).toFixed(0)),
    band:
      coverage === null
        ? "N/A"
        : coverage >= 1
          ? "ADEQUATE"
          : coverage >= 0.85
            ? "TIGHT"
            : "SHORT",
    rank_rule: rankRule,
    allocation,
    crowded: allocation.filter((a) => a.shortfall > 0.05).map((a) => a.name),
  };
}

const DEFAULT_FLOWS = {
  fund: "Demo Fund V (synthetic - invented names, illustrative only)",
  as_of: "2026-09-30",
  committed: 100,
  cashflows: [
    { date: "2021-03-31", type: "Call", amount: -25 },
    { date: "2022-06-30", type: "Call", amount: -20 },
    { date: "2023-03-31", type: "Call", amount: -15 },
    { date: "2024-11-15", type: "Distribution", amount: 8 },
    { date: "2026-03-31", type: "Distribution", amount: 12 },
    { date: "2026-09-30", type: "NAV", amount: 70 },
  ],
};

const METRICS_TOOL_DEF = {
  type: "function",
  function: {
    name: "run_fund_metrics",
    description:
      "Deterministically compute DPI, RVPI, TVPI and XIRR from dated cashflows (Call negative, Distribution positive, NAV terminal inflow) and return an eight-line IC note. Omit 'book' to use the built-in synthetic demo (paid-in 60, distributed 20, NAV 70).",
    parameters: {
      type: "object",
      properties: {
        book: {
          type: "object",
          properties: {
            fund: { type: "string" },
            as_of: { type: "string", description: "YYYY-MM-DD" },
            committed: { type: "number" },
            cashflows: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  date: { type: "string", description: "YYYY-MM-DD" },
                  type: { type: "string", enum: ["Call", "Distribution", "NAV"] },
                  amount: { type: "number" },
                },
                required: ["date", "type", "amount"],
              },
            },
          },
          required: ["cashflows"],
        },
      },
    },
  },
};

function xirr(pairs) {
  const xs = pairs.filter((p) => p[1] !== 0 && p[0] instanceof Date && !isNaN(p[0]));
  if (xs.length < 2) return null;
  const d0 = xs.reduce((m, p) => (p[0] < m ? p[0] : m), xs[0][0]);
  const npv = (r) =>
    xs.reduce(
      (t, p) => t + p[1] / Math.pow(1 + r, (p[0] - d0) / (365 * 24 * 3600 * 1000)),
      0,
    );
  const hasPos = xs.some((p) => p[1] > 0);
  const hasNeg = xs.some((p) => p[1] < 0);
  if (!hasPos || !hasNeg) return null;
  let lo = -0.9999;
  let hi = 10;
  let nLo = npv(lo);
  let nHi = npv(hi);
  if (nLo * nHi > 0) {
    let found = false;
    for (const h of [20, 50, 100]) {
      hi = h;
      nHi = npv(hi);
      if (nLo * nHi <= 0) {
        found = true;
        break;
      }
    }
    if (!found) return null;
  }
  for (let k = 0; k < 80; k++) {
    const mid = (lo + hi) / 2;
    const nMid = npv(mid);
    if (Math.abs(nMid) < 1e-10) return mid;
    if (nLo * nMid <= 0) {
      hi = mid;
    } else {
      lo = mid;
      nLo = nMid;
    }
  }
  return (lo + hi) / 2;
}

function runFundMetrics(args) {
  const book = args.book || DEFAULT_FLOWS;
  let paid = 0;
  let dist = 0;
  let nav = 0;
  const pairs = [];
  for (const row of book.cashflows) {
    const d = new Date(String(row.date).slice(0, 10) + "T00:00:00Z");
    const a = Math.abs(Number(row.amount) || 0);
    if (row.type === "Call") {
      paid += a;
      pairs.push([d, -a]);
    } else if (row.type === "Distribution") {
      dist += a;
      pairs.push([d, a]);
    } else if (row.type === "NAV") {
      nav += a;
      pairs.push([d, a]);
    } else {
      return { error: "cashflow type must be Call, Distribution or NAV" };
    }
  }
  if (paid <= 0) return { error: "paid-in must be positive (add Call rows)" };

  const dpi = dist / paid;
  const rvpi = nav / paid;
  const tvpi = (dist + nav) / paid;
  const irr = xirr(pairs);
  const irrS = irr === null ? "n/a (need dated calls and inflows)" : (irr * 100).toFixed(1) + "%";
  const committed = Number(book.committed) || 0;
  const asOf = book.as_of || "as-of date not given";
  const fund = book.fund || "unnamed fund";
  const markLine =
    dpi < 0.5 && rvpi > dpi
      ? "The TVPI story is still marks, not cash."
      : "Realised value is doing more of the work than remaining marks.";
  const deploy =
    committed > 0
      ? `Paid-in ${paid.toFixed(1)} of committed ${committed.toFixed(1)} (${Math.round((paid / committed) * 100)}% called).`
      : `Paid-in ${paid.toFixed(1)}.`;

  return {
    fund,
    as_of: asOf,
    paid_in: Number(paid.toFixed(1)),
    distributed: Number(dist.toFixed(1)),
    nav: Number(nav.toFixed(1)),
    dpi: Number(dpi.toFixed(2)),
    rvpi: Number(rvpi.toFixed(2)),
    tvpi: Number(tvpi.toFixed(2)),
    tvpi_identity_holds: Math.abs(tvpi - (dpi + rvpi)) < 1e-9,
    irr_pct: irr === null ? null : Number((irr * 100).toFixed(1)),
    eight_line_ic_note: [
      `1. ${fund}, as at ${asOf}: TVPI ${tvpi.toFixed(2)}x / DPI ${dpi.toFixed(2)}x / RVPI ${rvpi.toFixed(2)}x / IRR ${irrS}.`,
      "2. TVPI is paper; DPI is cash banked; IRR is speed.",
      `3. LPs have realised ${dpi.toFixed(2)}x of cost; ${rvpi.toFixed(2)}x of value is still a mark.`,
      `4. ${markLine}`,
      `5. IRR ${irrS} is the clock; TVPI ${tvpi.toFixed(2)}x ignores time.`,
      `6. ${deploy}`,
      "7. Marks are concentrated in a few names; a write-down moves TVPI and IRR together.",
      "8. IC: what has to be true in the next 24 months for that mark to become a distribution?",
    ].join("\n"),
  };
}

export { runReservesCheck, runFundMetrics }; // exported for testing

// Best-effort per-instance rate limit (serverless instances reset, so this
// is a speed bump, not a wall; the real cap is the OpenAI budget limit).
const hits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const windowMs = 60 * 60 * 1000;
  const rec = (hits.get(ip) || []).filter((t) => now - t < windowMs);
  if (rec.length >= 30) return true;
  rec.push(now);
  hits.set(ip, rec);
  return false;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "POST only" });
  }
  if (!process.env.OPENAI_API_KEY) {
    return res.status(500).json({ error: "Server missing OPENAI_API_KEY" });
  }

  const ip =
    (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "unknown";
  if (rateLimited(ip)) {
    return res
      .status(429)
      .json({ error: "Rate limit reached. Try again in an hour." });
  }

  const clientMessages = Array.isArray(req.body?.messages)
    ? req.body.messages
    : null;
  if (!clientMessages || clientMessages.length === 0) {
    return res.status(400).json({ error: "messages array required" });
  }
  const messages = clientMessages
    .slice(-MAX_TURNS)
    .filter(
      (m) =>
        (m.role === "user" || m.role === "assistant") &&
        typeof m.content === "string",
    )
    .map((m) => ({ role: m.role, content: m.content.slice(0, MAX_CHARS) }));

  const convo = [{ role: "system", content: SYSTEM_PROMPT }, ...messages];

  try {
    for (let loop = 0; loop <= MAX_TOOL_LOOPS; loop++) {
      const resp = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: MODEL,
          messages: convo,
          tools: [TOOL_DEF, METRICS_TOOL_DEF],
          max_tokens: 800,
          temperature: 0.2,
        }),
      });

      if (!resp.ok) {
        const detail = await resp.text();
        console.error("OpenAI error", resp.status, detail.slice(0, 500));
        return res
          .status(502)
          .json({ error: "Model call failed. Try again shortly." });
      }

      const data = await resp.json();
      const msg = data.choices?.[0]?.message;
      if (!msg) {
        return res.status(502).json({ error: "Empty model response" });
      }

      if (msg.tool_calls?.length && loop < MAX_TOOL_LOOPS) {
        convo.push(msg);
        for (const call of msg.tool_calls) {
          let result;
          try {
            const parsed = JSON.parse(call.function.arguments || "{}");
            if (call.function.name === "run_fund_metrics") {
              result = runFundMetrics(parsed);
            } else if (call.function.name === "run_reserves_check") {
              result = runReservesCheck(parsed);
            } else {
              result = { error: `Unknown tool: ${call.function.name}` };
            }
          } catch (e) {
            result = { error: `Invalid inputs: ${e.message}` };
          }
          convo.push({
            role: "tool",
            tool_call_id: call.id,
            content: JSON.stringify(result),
          });
        }
        continue;
      }

      return res.status(200).json({ reply: msg.content || "" });
    }
    return res.status(502).json({ error: "Tool loop limit reached" });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Unexpected server error" });
  }
}
