# Fund Metrics & Reserves Agent

A public, browser-based methodology demo for venture and growth fund finance. The agent answers reserves-adequacy and fund-performance questions through an Anthropic-powered chat interface, while all portfolio calculations are handled by deterministic JavaScript functions.

**This project uses synthetic data only. It is not investment advice and is not associated with an actual fund or portfolio.**

## Features

- **Reserves adequacy**
  - Compares follow-on capacity with implied reserve needs
  - Applies conviction-specific reserve multiples
  - Reports coverage bands: `ADEQUATE`, `TIGHT`, or `SHORT`
  - Ranks companies and identifies fully reserved, partial, and crowded-out positions
- **Fund performance**
  - Calculates paid-in capital, distributions, NAV, DPI, RVPI, and TVPI
  - Calculates XIRR from dated cashflows
  - Generates an eight-line investment committee note
- **Interactive UI**
  - Synthetic demo prompts
  - Custom portfolio and cashflow inputs
  - Conversation history for follow-up questions

## Demo examples

The UI includes prompts for:

- Running the synthetic reserves demo
- Computing fund metrics and an IC note
- Stress-testing reserve multiples
- Explaining TVPI, DPI, and IRR

You can also paste a portfolio containing committed capital, a fee load, and companies with cost, NAV, and conviction:

```text
Committed 350
Fee load 25
Solace: cost 28, NAV 62, Winner
Veda: cost 20, NAV 28, Core
Lumen: cost 14, NAV 11, Watch
```

## Reserves methodology

The reserves calculator uses the following defaults:

- Follow-on capacity: `70%` of remaining dry powder
- Winner reserve multiple: `2.0x`
- Core reserve multiple: `1.0x`
- Watch reserve multiple: `0.25x`
- Ranking: conviction first, then MOIC

The capacity bridge is:

```text
dry powder = committed - invested - fee load
capacity = dry powder x follow-on percentage
coverage = capacity / total implied reserve need
```

Coverage bands are:

| Coverage | Band |
| --- | --- |
| 100% or more | `ADEQUATE` |
| 85% to less than 100% | `TIGHT` |
| Less than 85% | `SHORT` |

## Performance methodology

The metrics calculator expects dated cashflows:

- `Call`: negative amount or call value
- `Distribution`: positive amount or distribution value
- `NAV`: positive terminal mark value

```text
DPI  = distributions / paid-in
RVPI = NAV / paid-in
TVPI = distributed value / paid-in + NAV / paid-in
XIRR = annualized rate that sets dated cashflow NPV to zero
```

The model is instructed to explain these figures, but it does not perform the arithmetic. Tool calls produce the deterministic calculator outputs used in the response.

## Architecture

- `index.html` - static chat interface and example prompts
- `chat.js` - Vercel serverless handler, Anthropic API integration, and deterministic calculators
- `vercel.json` - routes `/chat` to the serverless function and serves static files
- `package.json` - ESM package metadata

## Requirements

- Node.js
- An Anthropic API key
- Vercel CLI for the recommended local development flow

## Environment variables

Set the following variables in your deployment environment or local Vercel development session:

```text
ANTHROPIC_API_KEY=your-api-key
MODEL=claude-haiku-4-5
```

`ANTHROPIC_API_KEY` is required. `MODEL` is optional and defaults to `claude-haiku-4-5`.

## Local development

Install the Vercel CLI if it is not already available:

```bash
npm install --global vercel
```

Create `.env.local`:

```bash
ANTHROPIC_API_KEY=your-api-key
MODEL=claude-haiku-4-5
```

Start the app:

```bash
vercel dev
```

Open the local URL printed by Vercel.

## API

The chat server is exposed as `POST /chat`:

```json
{
  "messages": [
    {
      "role": "user",
      "content": "Run the reserves check on the demo book."
    }
  ]
}
```

Successful responses:

```json
{
  "reply": "..."
}
```

The handler limits each message to 4,000 characters, retains at most 24 messages, allows at most three tool loops per request, and limits each client IP to 30 requests per hour.

## Deployment

Deploy as a Vercel project and add `ANTHROPIC_API_KEY` to the project environment variables. The repository configuration:

- serves `index.html` as the static page
- routes `POST /chat` to `chat.js`
- serves `README.md` as a static route

## Safety and scope

- Demo company names and fund data are invented
- The app has no access to real fund or portfolio records
- Conviction labels are scenario inputs and are not investment recommendations
- The methodology demonstrates fund-finance calculations and should not be used as financial advice
