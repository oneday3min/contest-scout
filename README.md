# Contest Scout

**Read contest pages, rank what your team can actually win, and plan it to the deadline.**

- Live demo: https://contest-scout.onrender.com (free instance: the first load after it has been idle can take about a minute)
- Demo video: https://youtu.be/CN2jn5aj8SU

Small creator teams lose prize money in two ways: they miss contests they could have won, and they spend weeks on contests they never had a chance in. Rules pages are long, deadlines come in different time zones, and the details that decide everything (who can enter, how many winners there are, what you have to hand in) are buried in legal text.

Contest Scout reads the page for you with NVIDIA Nemotron on Nebius Token Factory:

1. **Extract**: paste a URL or the page text. A fast Nemotron model pulls out the deadline (with time zone), eligibility, prizes, winner count, deliverables and judging criteria, and quotes the sentence each fact came from.
2. **Score**: a reasoning Nemotron model scores the contest against *your* team profile on four axes (win odds, time, resources, cash) and gives a go / maybe / skip verdict with reasons and blockers.
3. **Plan**: you get a dated checklist from today to the deadline. Steps only a human can do (sign-ups, identity checks, final submission) are marked. Export it to your calendar (.ics) or the whole board to Markdown.
4. **Find** (optional): search the web for new contests with Tavily, then analyze any result in one click.

Track: **Best Apps and Agents**.

## How NVIDIA Nemotron and Nebius Token Factory are used

| Step | Model (default) | Why |
|---|---|---|
| Extract facts + evidence | Nemotron Nano (`NEBIUS_MODEL_FAST`) | Long pages, structured JSON, needs to be fast and cheap |
| Score + plan | Nemotron Super / Ultra (`NEBIUS_MODEL_REASON`) | Weighs eligibility, pool size and team fit, and reasons about dates |

- All inference is a runtime call to the Token Factory OpenAI-compatible API (`https://api.tokenfactory.nebius.com/v1/chat/completions`).
- On start the server calls `GET /v1/models` and picks the Nemotron models available to your key (Nano for fast, Ultra or Super for reasoning). You can pin exact IDs in `.env`.
- Token usage for each step is shown after every analysis.

## Run it

Needs Node.js 18 or newer. No npm install, no dependencies.

```bash
cp .env.example .env      # add your NEBIUS_API_KEY (and optionally TAVILY_API_KEY)
node server.js
# open http://localhost:8787
```

Without a key the app runs in **demo mode**: a simple rule-based guess, clearly labeled, so you can try the UI. Click "load the sample board" to see two real hackathons analyzed.

## Deploy (free)

`render.yaml` deploys to Render's free plan from this repo. Add `NEBIUS_API_KEY` in the Render dashboard.
The public demo protects your credits: identical requests are cached for 24 hours, and live AI runs are capped per day (`DAILY_LIVE_LIMIT`) and per visitor per hour (`HOURLY_PER_IP`). Pages are trimmed to `MAX_PAGE_CHARS` before they reach the model.

## Accuracy check

`eval/cases.json` holds contests whose deadline and eligibility we verified by hand (English pages in Pacific time, a Korean page in KST, and a closed contest that must be skipped). With the server running:

```bash
node eval/run.js
```

It prints each check, the total score, and the tokens used.

| Mode | Score | Notes |
|---|---|---|
| Rule-based demo (no model) | 4/8 | Mistakes "winners announced" dates for deadlines |
| Nemotron 3 Nano (extract) + Nemotron 3 Ultra (score) | **8/8** | Pacific time converted to KST correctly; closed contest skipped; ~32k tokens for all four cases |

Lesson learned: with hidden reasoning on, Nano spent its whole token budget thinking and returned truncated JSON. Extraction now runs with `enable_thinking: false`; reasoning stays on for scoring, where it pays off.

## Safety and honesty

- Every fact links to a verbatim quote from the page; unknowns stay "unknown" instead of being guessed.
- The server only fetches public http(s) pages and refuses local or private network addresses.
- Your board and profile stay in your browser (localStorage). Nothing is stored on the server.
- Contest Scout never signs up or submits for you; those steps are marked "human only".

## Project structure

```
server.js              Node HTTP server, Token Factory + Tavily calls, page fetching
public/index.html      UI
public/app.js          Board, detail, plan, exports (browser)
public/styles.css      Light/dark theme, mobile layout
public/sample-board.json  Two real hackathons, analyzed (sample data)
```

## License

MIT, see [LICENSE](LICENSE).
