interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * WORDING IS LOAD-BEARING, same rule as labelAge's note in authority.ts. This
 * string is appended to a pack's thrown Error message (shared/src/http.ts),
 * and a thrown Error's message is exactly what the gateway hands back to the
 * caller as `content[0].text` when nothing rewrites it (workers/gateway/src
 * catches the throw and sets `rawResult.message = stripClassPrefix(error)`,
 * which does not touch this suffix) — so the original wording,
 * " [pipeworx-hosted origin — our own service, not a third party]", was not a
 * theoretical leak: it shipped live on pipeworx-catalog's 522s, 7 times in 6
 * hours on 2026-09-02 (see tests/golden-internal-service.test.ts), verbatim
 * naming Pipeworx as the host. check:hosting-claims never caught it because it
 * did not scan shared/ at all (task #2009). Reworded to describe the
 * OBSERVATION (the origin did not answer) without a claim about who runs it —
 * the identical fix labelAge got: drop the possessive, keep the fact.
 */
const INTERNAL_ORIGIN_MARKER = ' [origin did not respond — retry before concluding the named source is down]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * `workers/gateway/src/provenance.ts`'s `OUR_HOSTS` answers the same
 * question and DOES include `workers.dev` — a documented divergence
 * (task #2051), not a bug to converge. That list decides what a response may
 * cite as a data SOURCE, where a false negative (citing our own worker as an
 * external source) is the hosting-disclosure leak this whole file exists to
 * prevent, so it errs broad. This one decides who gets BLAMED for a 5xx in
 * outage metrics read by on-call, where a false positive (crediting our own
 * infra with a third party's outage) hides the real failure, so it errs
 * narrow. Same suffix, opposite direction, because they are never called for
 * the same reason.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}


/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}`,
    res.url,
    res.status,
  );
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    throw err;
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}
/**
 * Taiwan equities MCP. Keyless.
 *
 * We shipped `china-stocks` (A-shares) and `hk-stocks` (HKEX) but nothing for
 * Taiwan, which left a hole in the middle of the region we otherwise cover —
 * `search_packs("Taiwan stock market data")` returned china-stocks, edgar,
 * sec-insider and alphavantage, none of which can price 2330.
 *
 * Sources — both official exchange open-data APIs, keyless, no quota:
 *  - TWSE  openapi.twse.com.tw/v1   (上市 / main board, ~1,100 companies)
 *  - TPEx  www.tpex.org.tw/openapi/v1 (上櫃 / OTC main board)
 *
 * Three shape traps, all verified against live payloads on 2026-08-20:
 *
 * 1. DATES ARE MIXED CALENDARS. Most endpoints stamp the Republic-of-China
 *    year — "1150819" is 2026-08-19 (115 + 1911), and "11507" is 2026-07 — but
 *    MI_INDEX20 and TPEx's index history stamp plain Gregorian "20260819".
 *    Reading one as the other silently yields a date a century out, so every
 *    date goes through `isoDate()` which branches on length and leading digits.
 *
 * 2. SOME JSON KEYS CARRY TRAILING SPACES. t187ap04_L's subject field is
 *    literally `"主旨 "`. A plain `row['主旨']` returns undefined and the
 *    announcement comes back with an empty headline, which reads as "the
 *    exchange published nothing" rather than "we misread the key". `rows()`
 *    trims every key on ingest.
 *
 * 3. THESE ARE WHOLE-MARKET SNAPSHOTS, NOT PER-SYMBOL ENDPOINTS. There is no
 *    `/quote/2330`; the smallest unit on offer is "every security that traded
 *    today" (318 KB on TWSE, 4 MB on TPEx). So we fetch the market file, cache
 *    it in-isolate for 5 minutes, and index it — and we always try the smaller
 *    TWSE file first, falling through to TPEx only when the code isn't listed.
 *
 * Company names are Chinese. Agents ask in English ("TSMC", "Taiwan
 * Semiconductor"), so the resolver indexes the English abbreviation TWSE
 * publishes in its company master (t187ap03_L: 英文簡稱 = "TSMC") alongside the
 * Chinese full and short names, and every tool that takes a symbol accepts a
 * name instead of a code.
 */


// Bound every fetch() in this pack to a fixed timeout — an upstream that
// degrades without erroring would otherwise hold the Worker in `await fetch()`
// until its own execution budget kills the request (minutes, not seconds).
// Mirrors the epoFetch / usaspending retryFetch pattern (fleet #685).
async function pwFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  return fetchWithTimeout(url, init ?? {}, 'Taiwan equities');
}

const TWSE = 'https://openapi.twse.com.tw/v1';
const TPEX = 'https://www.tpex.org.tw/openapi/v1';
const UA = 'Mozilla/5.0 (compatible; pipeworx-mcp/1.0; +https://pipeworx.io)';

const SOURCE = {
  twse: 'Taiwan Stock Exchange open data (openapi.twse.com.tw)',
  tpex: 'Taipei Exchange open data (www.tpex.org.tw/openapi)',
};

type Row = Record<string, string>;

/**
 * TWSE industry codes → the exchange's own Chinese sector label, derived by
 * joining the company master (numeric 產業別) against the monthly-revenue file
 * (which spells the same sector out) over all 1,095 listed companies. Every
 * code resolved 1:1, so this is transcribed from the data rather than guessed.
 */
const INDUSTRY: Record<string, { zh: string; en: string }> = {
  '01': { zh: '水泥工業', en: 'Cement' },
  '02': { zh: '食品工業', en: 'Food' },
  '03': { zh: '塑膠工業', en: 'Plastics' },
  '04': { zh: '紡織纖維', en: 'Textiles' },
  '05': { zh: '電機機械', en: 'Electric Machinery' },
  '06': { zh: '電器電纜', en: 'Electrical & Cable' },
  '08': { zh: '玻璃陶瓷', en: 'Glass & Ceramics' },
  '09': { zh: '造紙工業', en: 'Paper & Pulp' },
  '10': { zh: '鋼鐵工業', en: 'Iron & Steel' },
  '11': { zh: '橡膠工業', en: 'Rubber' },
  '12': { zh: '汽車工業', en: 'Automobile' },
  '14': { zh: '建材營造', en: 'Building Material & Construction' },
  '15': { zh: '航運業', en: 'Shipping & Transportation' },
  '16': { zh: '觀光餐旅', en: 'Tourism & Hospitality' },
  '17': { zh: '金融保險業', en: 'Financial & Insurance' },
  '18': { zh: '貿易百貨', en: 'Trading & Consumer Goods' },
  '20': { zh: '其他', en: 'Other' },
  '21': { zh: '化學工業', en: 'Chemical' },
  '22': { zh: '生技醫療業', en: 'Biotechnology & Medical Care' },
  '23': { zh: '油電燃氣業', en: 'Oil, Gas & Electricity' },
  '24': { zh: '半導體業', en: 'Semiconductor' },
  '25': { zh: '電腦及週邊設備業', en: 'Computer & Peripheral Equipment' },
  '26': { zh: '光電業', en: 'Optoelectronic' },
  '27': { zh: '通信網路業', en: 'Communications & Internet' },
  '28': { zh: '電子零組件業', en: 'Electronic Parts & Components' },
  '29': { zh: '電子通路業', en: 'Electronic Products Distribution' },
  '30': { zh: '資訊服務業', en: 'Information Service' },
  '31': { zh: '其他電子業', en: 'Other Electronic' },
  '35': { zh: '綠能環保', en: 'Green Energy & Environmental Services' },
  '36': { zh: '數位雲端', en: 'Digital & Cloud Services' },
  '37': { zh: '運動休閒', en: 'Sports & Leisure' },
  '38': { zh: '居家生活', en: 'Home Living' },
  '91': { zh: '存託憑證', en: 'Depositary Receipts' },
};

// ---------------------------------------------------------------------------
// fetch + cache
// ---------------------------------------------------------------------------

const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map<string, { at: number; rows: Row[] }>();

/**
 * TPEx refuses Cloudflare's egress. Verified from the deployed gateway on
 * 2026-08-20: `www.tpex.org.tw` answers HTTP 520 and then a redirect loop into
 * `/errors`, while the identical URL with the identical headers — same
 * User-Agent, same Accept — returns 200 from a laptop. Replaying the worker's
 * exact headers locally is what rules out the uk-gazette header-bug class and
 * leaves whose IP we leave from as the only explanation.
 *
 * So TPEx goes through the egress relay when the gateway injects one. TWSE is
 * reachable directly and stays direct — there is no reason to pay an extra hop
 * for a host that answers us.
 */
let PROXY: { url: string; token: string } | null = null;

async function rawFetch(url: string): Promise<Response> {
  const headers = { 'User-Agent': UA, Accept: 'application/json' };
  if (!PROXY || !url.startsWith(TPEX)) return pwFetch(url, { headers });
  const res = await pwFetch(PROXY.url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${PROXY.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  });
  // The gateway and the relay deploy on separate tracks (push-to-main CI vs.
  // `supabase functions deploy`), so the gateway can start injecting relay
  // credentials before the relay's allow-list knows this host. Falling back to
  // direct egress keeps the two deployable in either order.
  if (res.status === 403) {
    const body = await res.clone().text();
    if (body.includes('host_not_allowed')) {
      PROXY = null;
      return pwFetch(url, { headers });
    }
  }
  return res;
}

/**
 * Fetch one open-data file as trimmed-key rows.
 *
 * Key trimming is not cosmetic — see trap 2 in the header. The cache is
 * in-isolate and short-lived: these are once-a-day files, and a single tool
 * call routinely needs two of them (quotes + the company master to turn
 * "TSMC" into 2330).
 */
async function rows(base: string, path: string, label: string): Promise<Row[]> {
  const url = `${base}/${path}`;
  const hit = cache.get(url);
  const now = Date.now();
  if (hit && now - hit.at < CACHE_TTL_MS) return hit.rows;

  const res = await rawFetch(url);
  if (!res.ok) throw await httpError(res, label);

  const body = await res.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    // A 200 carrying HTML is a maintenance page or a bot wall, never a caller
    // mistake — say so, so it lands as an upstream problem and not our defect.
    throw new Error(`upstream_down: ${label} answered HTTP 200 with a non-JSON body (${body.slice(0, 80)}).`);
  }
  if (!Array.isArray(parsed)) throw new Error(`upstream_down: ${label} returned ${typeof parsed}, expected an array of records.`);

  const out = (parsed as Record<string, unknown>[]).map((r) => {
    const o: Row = {};
    for (const [k, v] of Object.entries(r)) o[k.trim()] = v == null ? '' : String(v).trim();
    return o;
  });
  cache.set(url, { at: now, rows: out });
  return out;
}

/**
 * The TPEx half of every tool, made non-fatal.
 *
 * TWSE is the main board — TSMC, Foxconn, the TAIEX, monthly revenue, the
 * disclosure feed — and it answers us fine. Letting an unreachable TPEx throw
 * would take all of that down with it, which is the wrong trade for the smaller
 * board. So a TPEx failure returns null and each caller says so explicitly:
 * `tpex_unavailable: true` with a reason, never an empty list. An OTC symbol we
 * could not reach and an OTC symbol that does not exist are different answers,
 * and collapsing them into "no results" is how a caller concludes the company
 * isn't listed when we simply could not get there.
 */
const TPEX_UNAVAILABLE = {
  tpex_unavailable: true,
  tpex_reason: 'upstream_refused_gateway_egress',
  tpex_note:
    'The Taipei Exchange (TPEx, 上櫃 / OTC board) refused this request. TWSE main-board results below are complete and unaffected; OTC-listed securities are missing from this answer rather than absent from the market.',
};

async function tpexRows(path: string, label: string): Promise<Row[] | null> {
  try {
    return await rows(TPEX, path, label);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// scalars
// ---------------------------------------------------------------------------

function num(v: string | undefined): number | null {
  if (v == null) return null;
  const s = v.replace(/,/g, '').replace(/^\+/, '').trim();
  if (!s || s === '-' || s === '--' || s === '－') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * Normalize whichever calendar an endpoint happens to use into ISO.
 *
 * 7 digits  = ROC yyyMMdd  ("1150819" → 2026-08-19)
 * 8 digits  = Gregorian    ("20260819" → 2026-08-19)
 * 5-6 digits= ROC yyyMM    ("11507"   → 2026-07)
 * "a~b"     = ROC range, both ends converted
 */
function isoDate(raw: string | undefined): string | null {
  if (!raw) return null;
  const s = raw.trim();
  if (s.includes('~')) {
    const parts = s.split('~').map((p) => isoDate(p)).filter(Boolean);
    return parts.length === 2 ? `${parts[0]}/${parts[1]}` : (parts[0] ?? null);
  }
  const d = s.replace(/\D/g, '');
  if (d.length === 8) return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
  if (d.length === 7) return `${Number(d.slice(0, 3)) + 1911}-${d.slice(3, 5)}-${d.slice(5, 7)}`;
  if (d.length === 6 && Number(d.slice(0, 4)) > 1911) return `${d.slice(0, 4)}-${d.slice(4, 6)}`;
  if (d.length === 5 || d.length === 6) return `${Number(d.slice(0, d.length - 2)) + 1911}-${d.slice(-2)}`;
  return s || null;
}

/** "70003" → "07:00:03" (the announcement files stamp HHmmss unpadded). */
function isoTime(raw: string | undefined): string | null {
  if (!raw) return null;
  const d = raw.replace(/\D/g, '').padStart(6, '0');
  if (d.length !== 6) return null;
  return `${d.slice(0, 2)}:${d.slice(2, 4)}:${d.slice(4, 6)}`;
}

function clampLimit(v: unknown, dflt: number, max: number): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  if (!Number.isFinite(n)) return dflt;
  return Math.max(1, Math.min(max, Math.trunc(n)));
}

function asList(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
  if (typeof v === 'string') return v.split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean);
  return [];
}

// ---------------------------------------------------------------------------
// symbol resolution
// ---------------------------------------------------------------------------

type Security = {
  code: string;
  name: string;
  english_name: string | null;
  market: 'TWSE' | 'TPEx';
  industry: string | null;
};

/** Taiwan codes are 4 digits for ordinary shares; ETFs and the newer active
 *  funds add a suffix ("00400A", "00679B"). Anything of that shape is taken
 *  as a code rather than a name. */
function looksLikeCode(s: string): boolean {
  return /^[0-9]{4,6}[A-Za-z]?$/.test(s.trim().replace(/\.(TW|TWO)$/i, ''));
}

function normCode(s: string): string {
  return s.trim().toUpperCase().replace(/\.(TW|TWO)$/i, '');
}

async function twseCompanies(): Promise<Security[]> {
  const raw = await rows(TWSE, 'opendata/t187ap03_L', 'TWSE company master');
  return raw.map((r) => ({
    code: r['公司代號'] ?? '',
    name: r['公司簡稱'] || r['公司名稱'] || '',
    english_name: r['英文簡稱'] || null,
    market: 'TWSE' as const,
    industry: INDUSTRY[r['產業別'] ?? '']?.en ?? (r['產業別'] || null),
  })).filter((s) => s.code);
}

async function tpexSecurities(): Promise<Security[] | null> {
  const raw = await tpexRows('tpex_mainboard_daily_close_quotes', 'TPEx daily quotes');
  if (!raw) return null;
  const seen = new Set<string>();
  const out: Security[] = [];
  for (const r of raw) {
    const code = r['SecuritiesCompanyCode'] ?? '';
    if (!code || seen.has(code)) continue;
    seen.add(code);
    out.push({ code, name: r['CompanyName'] ?? '', english_name: null, market: 'TPEx', industry: null });
  }
  return out;
}

function scoreMatch(sec: Security, q: string): number {
  const ql = q.toLowerCase();
  const en = (sec.english_name ?? '').toLowerCase();
  if (sec.code.toLowerCase() === ql) return 100;
  if (en && en === ql) return 95;
  if (sec.name === q) return 90;
  if (en && en.startsWith(ql)) return 70;
  if (sec.name.startsWith(q)) return 65;
  if (en && en.includes(ql)) return 50;
  if (sec.name.includes(q)) return 45;
  return 0;
}

/**
 * Turn whatever the caller passed into a listed security.
 *
 * Agents pass "TSMC", "台積電", "2330" and "2330.TW" interchangeably, so all
 * four resolve. A code is trusted without a lookup — ETFs and warrants trade
 * on TWSE without appearing in the company master, and refusing them because
 * they aren't companies would reject valid symbols.
 */
async function resolve(input: string): Promise<Security | null> {
  const q = input.trim();
  if (!q) return null;
  if (looksLikeCode(q)) {
    const code = normCode(q);
    const listed = (await twseCompanies()).find((s) => s.code === code);
    if (listed) return listed;
    const otc = (await tpexSecurities())?.find((s) => s.code === code);
    if (otc) return otc;
    return { code, name: '', english_name: null, market: 'TWSE', industry: null };
  }
  const pool = [...(await twseCompanies()), ...((await tpexSecurities()) ?? [])];
  let best: Security | null = null;
  let bestScore = 0;
  for (const s of pool) {
    const sc = scoreMatch(s, q);
    if (sc > bestScore) {
      bestScore = sc;
      best = s;
    }
  }
  return bestScore >= 45 ? best : null;
}

function notFound(symbol: string) {
  return {
    found: false,
    reason: 'symbol_not_found',
    symbol,
    hint: `No Taiwan-listed security matched "${symbol}". Search first with taiwan_search_securities({ query: "${symbol}" }) — it matches the exchange's English abbreviation (TSMC), the Chinese name (台積電) and the numeric code (2330).`,
  };
}

// ---------------------------------------------------------------------------
// tools
// ---------------------------------------------------------------------------

async function stockQuote(args: Record<string, unknown>) {
  const wanted = asList(args.symbols ?? args.symbol);
  if (!wanted.length) {
    return { found: false, reason: 'missing_symbol', hint: 'Pass symbols, e.g. taiwan_stock_quote({ symbols: "2330" }) or symbols: ["TSMC", "2317"].' };
  }
  const twseRows = await rows(TWSE, 'exchangeReport/STOCK_DAY_ALL', 'TWSE daily quotes');
  const twseByCode = new Map(twseRows.map((r) => [r['Code'] ?? '', r]));

  let tpexByCode: Map<string, Row> | null = null;
  let tpexDown = false;
  const quotes: unknown[] = [];
  const unresolved: unknown[] = [];

  for (const w of wanted.slice(0, 20)) {
    const sec = await resolve(w);
    if (!sec) {
      unresolved.push(notFound(w));
      continue;
    }
    const t = twseByCode.get(sec.code);
    if (t) {
      quotes.push({
        query: w,
        code: sec.code,
        name: t['Name'] || sec.name,
        english_name: sec.english_name,
        market: 'TWSE',
        date: isoDate(t['Date']),
        open: num(t['OpeningPrice']),
        high: num(t['HighestPrice']),
        low: num(t['LowestPrice']),
        close: num(t['ClosingPrice']),
        change: num(t['Change']),
        volume_shares: num(t['TradeVolume']),
        turnover_twd: num(t['TradeValue']),
        transactions: num(t['Transaction']),
        currency: 'TWD',
      });
      continue;
    }
    if (!tpexByCode && !tpexDown) {
      const otc = await tpexRows('tpex_mainboard_daily_close_quotes', 'TPEx daily quotes');
      if (otc) tpexByCode = new Map(otc.map((r) => [r['SecuritiesCompanyCode'] ?? '', r]));
      else tpexDown = true;
    }
    const o = tpexByCode?.get(sec.code);
    if (o) {
      quotes.push({
        query: w,
        code: sec.code,
        name: o['CompanyName'] || sec.name,
        english_name: sec.english_name,
        market: 'TPEx',
        date: isoDate(o['Date']),
        open: num(o['Open']),
        high: num(o['High']),
        low: num(o['Low']),
        close: num(o['Close']),
        change: num(o['Change']),
        average: num(o['Average']),
        volume_shares: num(o['TradingShares']),
        turnover_twd: num(o['TransactionAmount']),
        transactions: num(o['TransactionNumber']),
        next_limit_up: num(o['NextLimitUp']),
        next_limit_down: num(o['NextLimitDown']),
        currency: 'TWD',
      });
      continue;
    }
    unresolved.push(
      tpexDown
        ? {
            found: false,
            reason: 'tpex_unreachable',
            symbol: w,
            code: sec.code,
            hint: `${sec.code} is not on the TWSE main board, and the Taipei Exchange refused this request, so we could not check the OTC board for it. This is our reach failing, not a statement that ${sec.code} does not trade.`,
          }
        : {
            found: false,
            reason: 'no_quote_for_session',
            symbol: w,
            code: sec.code,
            hint: `${sec.code} resolved but did not trade in the latest published session (suspended, delisted, or not yet listed). taiwan_company_profile({ symbol: "${sec.code}" }) shows whether it is still listed.`,
          },
    );
  }

  return {
    count: quotes.length,
    quotes,
    unresolved,
    ...(tpexDown ? TPEX_UNAVAILABLE : {}),
    note: 'End-of-day close for the latest published session. Both exchanges publish after the 13:30 Taipei close; before then the newest date shown is the previous session.',
    source: [SOURCE.twse, SOURCE.tpex],
  };
}

async function searchSecurities(args: Record<string, unknown>) {
  const query = String(args.query ?? '').trim();
  if (!query) return { found: false, reason: 'missing_query', hint: 'Pass a company name, English abbreviation or code, e.g. taiwan_search_securities({ query: "semiconductor" }).' };
  const limit = clampLimit(args.limit, 20, 100);
  const market = String(args.market ?? 'all').toLowerCase();

  const pool: Security[] = [];
  let tpexDown = false;
  if (market !== 'tpex') pool.push(...(await twseCompanies()));
  if (market !== 'twse') {
    const otc = await tpexSecurities();
    if (otc) pool.push(...otc);
    else tpexDown = true;
  }

  const scored = pool
    .map((s) => ({ s, score: scoreMatch(s, query) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.s.code.localeCompare(b.s.code));

  if (!scored.length) {
    return {
      found: false,
      reason: 'no_match',
      query,
      hint: 'Try the numeric code (2330), the exchange English abbreviation (TSMC) or the Chinese short name (台積電). Sector words match only through the industry label, so search by company instead.',
      ...(tpexDown ? TPEX_UNAVAILABLE : {}),
      source: [SOURCE.twse, SOURCE.tpex],
    };
  }

  return {
    query,
    count: scored.length,
    matches: scored.slice(0, limit).map((x) => ({
      code: x.s.code,
      name: x.s.name,
      english_name: x.s.english_name,
      market: x.s.market,
      industry: x.s.industry,
    })),
    truncated: scored.length > limit,
    ...(tpexDown ? TPEX_UNAVAILABLE : {}),
    next_step: `Pass a code to taiwan_stock_quote, e.g. taiwan_stock_quote({ symbols: "${scored[0]!.s.code}" }).`,
    source: [SOURCE.twse, SOURCE.tpex],
  };
}

async function companyProfile(args: Record<string, unknown>) {
  const symbol = String(args.symbol ?? '').trim();
  if (!symbol) return { found: false, reason: 'missing_symbol', hint: 'Pass a company code or name, e.g. taiwan_company_profile({ symbol: "2330" }).' };
  const sec = await resolve(symbol);
  if (!sec) return notFound(symbol);

  const master = await rows(TWSE, 'opendata/t187ap03_L', 'TWSE company master');
  const r = master.find((x) => x['公司代號'] === sec.code);
  if (!r) {
    return {
      found: false,
      reason: 'not_in_company_master',
      symbol,
      code: sec.code,
      market: sec.market,
      hint: sec.market === 'TPEx'
        ? `${sec.code} trades on the Taipei Exchange (OTC). The company master this tool reads covers TWSE main-board listings; taiwan_stock_quote and taiwan_stock_valuation do cover TPEx.`
        : `${sec.code} trades on TWSE but is not a listed company record — ETFs, depositary receipts and warrants have no company profile. taiwan_stock_quote({ symbols: "${sec.code}" }) still prices it.`,
    };
  }

  const ind = INDUSTRY[r['產業別'] ?? ''];
  return {
    code: sec.code,
    name_zh: r['公司名稱'] ?? null,
    short_name_zh: r['公司簡稱'] ?? null,
    english_abbreviation: r['英文簡稱'] || null,
    market: 'TWSE',
    industry_code: r['產業別'] || null,
    industry: ind?.en ?? null,
    industry_zh: ind?.zh ?? null,
    chairman: r['董事長'] || null,
    president: r['總經理'] || null,
    spokesperson: r['發言人'] || null,
    spokesperson_title: r['發言人職稱'] || null,
    incorporated: isoDate(r['成立日期']),
    listed: isoDate(r['上市日期']),
    paid_in_capital_twd: num(r['實收資本額']),
    common_shares_outstanding: num(r['已發行普通股數或TDR原股發行股數']),
    preferred_shares: num(r['特別股']),
    tax_id: r['營利事業統一編號'] || null,
    address: r['住址'] || null,
    english_address: r['英文通訊地址'] || null,
    phone: r['總機電話'] || null,
    email: r['電子郵件信箱'] || null,
    website: r['網址'] || null,
    auditor: r['簽證會計師事務所'] || null,
    foreign_registration: r['外國企業註冊地國'] && r['外國企業註冊地國'] !== '－' ? r['外國企業註冊地國'] : null,
    as_of: isoDate(r['出表日期']),
    source: SOURCE.twse,
  };
}

async function marketSummary(args: Record<string, unknown>) {
  const days = clampLimit(args.days, 5, 30);

  const [turnover, taiex, otc] = await Promise.all([
    rows(TWSE, 'exchangeReport/FMTQIK', 'TWSE market turnover'),
    rows(TWSE, 'indicesReport/MI_5MINS_HIST', 'TAIEX history'),
    tpexRows('tpex_index', 'TPEx index history'),
  ]);

  const taiexByDate = new Map(taiex.map((r) => [isoDate(r['Date']) ?? '', r]));
  const otcByDate = new Map((otc ?? []).map((r) => [isoDate(r['Date']) ?? '', r]));

  const sessions = turnover
    .map((r) => {
      const date = isoDate(r['Date']) ?? '';
      const idx = taiexByDate.get(date);
      const o = otcByDate.get(date);
      return {
        date,
        taiex_close: num(r['TAIEX']),
        taiex_change: num(r['Change']),
        taiex_open: idx ? num(idx['OpeningIndex']) : null,
        taiex_high: idx ? num(idx['HighestIndex']) : null,
        taiex_low: idx ? num(idx['LowestIndex']) : null,
        twse_turnover_twd: num(r['TradeValue']),
        twse_volume_shares: num(r['TradeVolume']),
        twse_transactions: num(r['Transaction']),
        tpex_index_close: o ? num(o['Close']) : null,
        tpex_index_change: o ? num(o['Change']) : null,
      };
    })
    .filter((s) => s.date)
    .sort((a, b) => b.date.localeCompare(a.date));

  const latest = sessions[0] ?? null;
  return {
    latest_session: latest,
    sessions: sessions.slice(0, days),
    ...(otc ? {} : TPEX_UNAVAILABLE),
    note: 'TAIEX (發行量加權股價指數) is the TWSE main-board benchmark; the TPEx index tracks the OTC main board. Both exchanges publish these files once per trading day, so the newest row is the last completed session.',
    source: [SOURCE.twse, SOURCE.tpex],
  };
}

async function stockValuation(args: Record<string, unknown>) {
  const wanted = asList(args.symbols ?? args.symbol);
  if (!wanted.length) return { found: false, reason: 'missing_symbol', hint: 'Pass symbols, e.g. taiwan_stock_valuation({ symbols: "2330" }).' };

  const twseVal = await rows(TWSE, 'exchangeReport/BWIBBU_ALL', 'TWSE valuation ratios');
  const twseByCode = new Map(twseVal.map((r) => [r['Code'] ?? '', r]));
  let tpexByCode: Map<string, Row> | null = null;
  let tpexDown = false;

  const valuations: unknown[] = [];
  const unresolved: unknown[] = [];

  for (const w of wanted.slice(0, 20)) {
    const sec = await resolve(w);
    if (!sec) {
      unresolved.push(notFound(w));
      continue;
    }
    const t = twseByCode.get(sec.code);
    if (t) {
      valuations.push({
        query: w,
        code: sec.code,
        name: t['Name'] || sec.name,
        market: 'TWSE',
        date: isoDate(t['Date']),
        pe_ratio: num(t['PEratio']),
        dividend_yield_pct: num(t['DividendYield']),
        price_to_book: num(t['PBratio']),
      });
      continue;
    }
    if (!tpexByCode && !tpexDown) {
      const otc = await tpexRows('tpex_mainboard_peratio_analysis', 'TPEx valuation ratios');
      if (otc) tpexByCode = new Map(otc.map((r) => [r['SecuritiesCompanyCode'] ?? '', r]));
      else tpexDown = true;
    }
    const o = tpexByCode?.get(sec.code);
    if (o) {
      valuations.push({
        query: w,
        code: sec.code,
        name: o['CompanyName'] || sec.name,
        market: 'TPEx',
        date: isoDate(o['Date']),
        pe_ratio: num(o['PriceEarningRatio']),
        dividend_yield_pct: num(o['YieldRatio']),
        dividend_per_share_twd: num(o['DividendPerShare']),
        price_to_book: num(o['PriceBookRatio']),
      });
      continue;
    }
    unresolved.push(
      tpexDown
        ? {
            found: false,
            reason: 'tpex_unreachable',
            symbol: w,
            code: sec.code,
            hint: `${sec.code} has no TWSE valuation row, and the Taipei Exchange refused this request, so its OTC ratios could not be checked.`,
          }
        : {
            found: false,
            reason: 'no_valuation_published',
            symbol: w,
            code: sec.code,
            hint: `The exchanges publish these ratios for ordinary shares only — ETFs, warrants and depositary receipts are absent. taiwan_stock_quote({ symbols: "${sec.code}" }) still returns its price.`,
          },
    );
  }

  return {
    count: valuations.length,
    valuations,
    unresolved,
    ...(tpexDown ? TPEX_UNAVAILABLE : {}),
    note: 'A blank P/E means the company has no trailing-twelve-month profit to divide by; a blank yield means no cash dividend in the trailing year.',
    source: [SOURCE.twse, SOURCE.tpex],
  };
}

async function monthlyRevenue(args: Record<string, unknown>) {
  const symbol = String(args.symbol ?? '').trim();
  const industry = String(args.industry ?? '').trim();
  const limit = clampLimit(args.limit, 20, 100);
  const all = await rows(TWSE, 'opendata/t187ap05_L', 'TWSE monthly revenue');

  const shape = (r: Row) => ({
    code: r['公司代號'],
    name: r['公司名稱'],
    industry_zh: r['產業別'],
    month: isoDate(r['資料年月']),
    revenue_twd_thousands: num(r['營業收入-當月營收']),
    prior_month_twd_thousands: num(r['營業收入-上月營收']),
    year_ago_month_twd_thousands: num(r['營業收入-去年當月營收']),
    mom_change_pct: num(r['營業收入-上月比較增減(%)']),
    yoy_change_pct: num(r['營業收入-去年同月增減(%)']),
    ytd_revenue_twd_thousands: num(r['累計營業收入-當月累計營收']),
    ytd_prior_year_twd_thousands: num(r['累計營業收入-去年累計營收']),
    ytd_change_pct: num(r['累計營業收入-前期比較增減(%)']),
    note: r['備註'] && r['備註'] !== '-' ? r['備註'] : null,
  });

  const dataMonth = isoDate(all[0]?.['資料年月']);

  if (symbol) {
    const sec = await resolve(symbol);
    if (!sec) return notFound(symbol);
    const r = all.find((x) => x['公司代號'] === sec.code);
    if (!r) {
      return {
        found: false,
        reason: 'no_revenue_filing',
        symbol,
        code: sec.code,
        data_month: dataMonth,
        hint: sec.market === 'TPEx'
          ? `${sec.code} is a Taipei Exchange (OTC) listing; this file covers TWSE main-board companies. taiwan_stock_quote and taiwan_stock_valuation do cover TPEx.`
          : `${sec.code} filed no revenue for ${dataMonth} — ETFs and depositary receipts never do, and a newly listed company may not yet.`,
      };
    }
    return { data_month: dataMonth, company: shape(r), note: 'Taiwan requires every listed company to publish its prior month\'s revenue by the 10th, which is why this arrives weeks ahead of any quarterly filing. Amounts are in thousands of TWD.', source: SOURCE.twse };
  }

  let pool = all;
  if (industry) {
    const il = industry.toLowerCase();
    const zhWanted = Object.values(INDUSTRY).find((i) => i.en.toLowerCase() === il || i.zh === industry)?.zh;
    pool = all.filter((r) => (zhWanted ? r['產業別'] === zhWanted : (r['產業別'] ?? '').toLowerCase().includes(il)));
    if (!pool.length) {
      return {
        found: false,
        reason: 'no_such_industry',
        industry,
        data_month: dataMonth,
        available_industries: Object.values(INDUSTRY).map((i) => i.en),
        hint: 'Pass one of available_industries, or drop the industry argument to rank the whole market.',
      };
    }
  }

  const ranked = pool
    .map(shape)
    .filter((x) => x.yoy_change_pct != null)
    .sort((a, b) => (b.yoy_change_pct ?? 0) - (a.yoy_change_pct ?? 0));

  return {
    data_month: dataMonth,
    industry: industry || 'all listed companies',
    count: ranked.length,
    ranked_by: 'year-on-year revenue growth, highest first',
    companies: ranked.slice(0, limit),
    note: 'Taiwan requires every listed company to publish its prior month\'s revenue by the 10th, which is why this arrives weeks ahead of any quarterly filing. Amounts are in thousands of TWD.',
    source: SOURCE.twse,
  };
}

async function materialNews(args: Record<string, unknown>) {
  const symbol = String(args.symbol ?? '').trim();
  const query = String(args.query ?? '').trim();
  const limit = clampLimit(args.limit, 20, 100);
  const all = await rows(TWSE, 'opendata/t187ap04_L', 'TWSE material information');

  let pool = all;
  let code: string | null = null;
  if (symbol) {
    const sec = await resolve(symbol);
    if (!sec) return notFound(symbol);
    code = sec.code;
    pool = pool.filter((r) => r['公司代號'] === code);
  }
  if (query) pool = pool.filter((r) => (r['主旨'] ?? '').includes(query) || (r['說明'] ?? '').includes(query) || (r['公司名稱'] ?? '').includes(query));

  const items = pool
    .map((r) => ({
      code: r['公司代號'],
      name: r['公司名稱'],
      announced: isoDate(r['發言日期']),
      announced_time: isoTime(r['發言時間']),
      event_date: isoDate(r['事實發生日']),
      subject: r['主旨'] || null,
      clause: r['符合條款'] || null,
      detail: (r['說明'] ?? '').slice(0, 1500) || null,
      detail_truncated: (r['說明'] ?? '').length > 1500,
    }))
    .sort((a, b) => `${b.announced}${b.announced_time}`.localeCompare(`${a.announced}${a.announced_time}`));

  if (!items.length) {
    return {
      found: false,
      reason: 'no_announcements_matched',
      symbol: symbol || null,
      code,
      query: query || null,
      published_today: all.length,
      hint: `This file holds only the announcements TWSE published in its latest daily batch (${all.length} today, all companies). A company that said nothing today appears here tomorrow at the earliest — it is not a gap in coverage.`,
      source: SOURCE.twse,
    };
  }

  return {
    count: items.length,
    published_in_batch: all.length,
    announcements: items.slice(0, limit),
    truncated: items.length > limit,
    note: '重大訊息 — the mandatory same-day disclosures TWSE-listed companies must make: board resolutions, mergers, litigation, large asset transactions, name changes. This is the latest daily batch only.',
    source: SOURCE.twse,
  };
}

async function topTraded(args: Record<string, unknown>) {
  const limit = clampLimit(args.limit, 20, 20);
  const raw = await rows(TWSE, 'exchangeReport/MI_INDEX20', 'TWSE most-traded securities');
  return {
    date: isoDate(raw[0]?.['Date']),
    count: Math.min(raw.length, limit),
    securities: raw.slice(0, limit).map((r) => ({
      rank: num(r['Rank']),
      code: r['Code'],
      name: r['Name'],
      volume_shares: num(r['TradeVolume']),
      transactions: num(r['Transaction']),
      open: num(r['OpeningPrice']),
      high: num(r['HighestPrice']),
      low: num(r['LowestPrice']),
      close: num(r['ClosingPrice']),
      change: r['Dir'] === '-' ? -(num(r['Change']) ?? 0) : num(r['Change']),
    })),
    note: 'The twenty most heavily traded TWSE securities of the session by share volume. Leveraged and inverse ETFs routinely top this list, so it reflects turnover rather than company size.',
    source: SOURCE.twse,
  };
}

async function foreignHoldings(args: Record<string, unknown>) {
  const mode = String(args.mode ?? 'top_holdings').toLowerCase();
  const limit = clampLimit(args.limit, 20, 40);

  if (mode === 'by_industry') {
    const raw = await rows(TWSE, 'fund/MI_QFIIS_cat', 'TWSE foreign holdings by industry');
    return {
      mode: 'by_industry',
      count: raw.length,
      industries: raw.map((r) => ({
        industry_zh: r['IndustryCat'],
        securities: num(r['Numbers']),
        shares_issued: num(r['ShareNumber']),
        shares_held_by_foreign_and_mainland: num(r['ForeignMainlandAreaShare']),
        held_pct: num(r['Percentage']),
      })).sort((a, b) => (b.held_pct ?? 0) - (a.held_pct ?? 0)),
      note: 'Share of each TWSE sector held by foreign and mainland-China investors, from the exchange\'s QFII register. A rising figure is the standard read on foreign appetite for Taiwan risk.',
      source: SOURCE.twse,
    };
  }

  const raw = await rows(TWSE, 'fund/MI_QFIIS_sort_20', 'TWSE top foreign-held securities');
  return {
    mode: 'top_holdings',
    count: Math.min(raw.length, limit),
    securities: raw.slice(0, limit).map((r) => ({
      rank: num(r['Rank']),
      code: r['Code'],
      name: r['Name'],
      shares_issued: num(r['ShareNumber']),
      shares_held_by_foreign_and_mainland: num(r['SharesHeld']),
      held_pct: num(r['SharesHeldPer']),
      remaining_investable_shares: num(r['AvailableShare']),
      remaining_investable_pct: num(r['AvailableInvestPer']),
      ceiling_pct: num(r['Upperlimit']),
    })),
    note: 'TWSE securities with the highest foreign and mainland-China ownership. remaining_investable_pct is the headroom left before the statutory ceiling; near zero means overseas buyers can no longer add.',
    source: SOURCE.twse,
  };
}

async function marginBalance(args: Record<string, unknown>) {
  const wanted = asList(args.symbols ?? args.symbol);
  if (!wanted.length) return { found: false, reason: 'missing_symbol', hint: 'Pass symbols, e.g. taiwan_margin_balance({ symbols: "2330" }).' };

  const twseRows = await rows(TWSE, 'exchangeReport/MI_MARGN', 'TWSE margin balances');
  const twseByCode = new Map(twseRows.map((r) => [r['股票代號'] ?? '', r]));
  let tpexByCode: Map<string, Row> | null = null;
  let tpexDown = false;

  const balances: unknown[] = [];
  const unresolved: unknown[] = [];

  for (const w of wanted.slice(0, 20)) {
    const sec = await resolve(w);
    if (!sec) {
      unresolved.push(notFound(w));
      continue;
    }
    const t = twseByCode.get(sec.code);
    if (t) {
      balances.push({
        query: w,
        code: sec.code,
        name: t['股票名稱'] || sec.name,
        market: 'TWSE',
        margin_balance_lots: num(t['融資今日餘額']),
        margin_balance_prior_lots: num(t['融資前日餘額']),
        margin_purchases_lots: num(t['融資買進']),
        margin_sales_lots: num(t['融資賣出']),
        margin_quota_lots: num(t['融資限額']),
        short_balance_lots: num(t['融券今日餘額']),
        short_balance_prior_lots: num(t['融券前日餘額']),
        short_sales_lots: num(t['融券賣出']),
        short_covering_lots: num(t['融券買進']),
        short_quota_lots: num(t['融券限額']),
        offset_lots: num(t['資券互抵']),
      });
      continue;
    }
    if (!tpexByCode && !tpexDown) {
      const otc = await tpexRows('tpex_mainboard_margin_balance', 'TPEx margin balances');
      if (otc) tpexByCode = new Map(otc.map((r) => [r['SecuritiesCompanyCode'] ?? '', r]));
      else tpexDown = true;
    }
    const o = tpexByCode?.get(sec.code);
    if (o) {
      balances.push({
        query: w,
        code: sec.code,
        name: o['CompanyName'] || sec.name,
        market: 'TPEx',
        date: isoDate(o['Date']),
        margin_balance_lots: num(o['MarginPurchaseBalance']),
        margin_balance_prior_lots: num(o['MarginPurchaseBalancePreviousDay']),
        margin_purchases_lots: num(o['MarginPurchase']),
        margin_sales_lots: num(o['MarginSales']),
        margin_utilization_pct: num(o['MarginPurchaseUtilizationRate']),
        short_balance_lots: num(o['ShortSaleBalance']),
        short_balance_prior_lots: num(o['ShortSaleBalancePreviousDay']),
        short_sales_lots: num(o['ShortSale']),
        short_covering_lots: num(o['ShortConvering']),
        short_utilization_pct: num(o['ShortSaleUtilizationRate']),
      });
      continue;
    }
    unresolved.push(
      tpexDown
        ? {
            found: false,
            reason: 'tpex_unreachable',
            symbol: w,
            code: sec.code,
            hint: `${sec.code} is not on the TWSE margin-eligible list, and the Taipei Exchange refused this request, so its OTC margin balance could not be checked.`,
          }
        : {
            found: false,
            reason: 'not_margin_eligible',
            symbol: w,
            code: sec.code,
            hint: `${sec.code} is not on either exchange's margin-eligible list, so no financing or short balance is published for it.`,
          },
    );
  }

  return {
    count: balances.length,
    balances,
    unresolved,
    ...(tpexDown ? TPEX_UNAVAILABLE : {}),
    note: 'Balances are in lots of 1,000 shares. 融資 (margin) is borrowing cash to buy; 融券 (short) is borrowing shares to sell. A short balance climbing against a flat price is the classic Taiwan retail squeeze setup. The TWSE file carries no date field — it is the latest published session.',
    source: [SOURCE.twse, SOURCE.tpex],
  };
}

async function exDividendCalendar(args: Record<string, unknown>) {
  const symbol = String(args.symbol ?? '').trim();
  const limit = clampLimit(args.limit, 30, 200);
  const all = await rows(TWSE, 'exchangeReport/TWT48U_ALL', 'TWSE ex-dividend calendar');

  let pool = all;
  let code: string | null = null;
  if (symbol) {
    const sec = await resolve(symbol);
    if (!sec) return notFound(symbol);
    code = sec.code;
    pool = pool.filter((r) => r['Code'] === code);
  }

  const kind = (v: string) => (v.includes('息') && v.includes('權') ? 'cash_and_stock' : v.includes('權') ? 'stock' : v.includes('息') ? 'cash' : v || null);

  const items = pool
    .map((r) => ({
      ex_date: isoDate(r['Date']),
      code: r['Code'],
      name: r['Name'],
      type: kind(r['Exdividend'] ?? ''),
      cash_dividend_twd: num(r['CashDividend']),
      stock_dividend_ratio: num(r['StockDividendRatio']),
      subscription_ratio: num(r['SubscriptionRatio']),
      subscription_price_twd: num(r['SubscriptionPricePerShare']),
      shares_offered: num(r['SharesOffered']),
    }))
    .sort((a, b) => (a.ex_date ?? '').localeCompare(b.ex_date ?? ''));

  if (!items.length) {
    return {
      found: false,
      reason: 'no_scheduled_ex_date',
      symbol: symbol || null,
      code,
      scheduled_in_file: all.length,
      hint: `This is TWSE's forward calendar of already-announced ex-dates (${all.length} scheduled). A company with nothing scheduled has not announced its next distribution yet; taiwan_stock_valuation({ symbols: "${code ?? '2330'}" }) gives its trailing dividend yield in the meantime.`,
      source: SOURCE.twse,
    };
  }

  return {
    count: items.length,
    entries: items.slice(0, limit),
    truncated: items.length > limit,
    note: 'Announced ex-dividend and ex-rights dates for TWSE listings. Buying on or after ex_date forgoes the distribution. Cash amounts are TWD per share; a stock_dividend_ratio is shares awarded per 1,000 held.',
    source: SOURCE.twse,
  };
}

// ---------------------------------------------------------------------------
// tool definitions
// ---------------------------------------------------------------------------

const tools: McpToolExport['tools'] = [
  {
    name: 'taiwan_stock_quote',
    description:
      'Daily close, open, high, low, change, share volume and TWD turnover for Taiwan-listed stocks and ETFs, from the Taiwan Stock Exchange (TWSE, 上市) and Taipei Exchange (TPEx, 上櫃) open data. Accepts the numeric code (2330), the exchange English abbreviation (TSMC) or the Chinese name (台積電). Answers "what did TSMC close at", "price of 2317", "how did Taiwanese stocks trade today".',
    inputSchema: {
      type: 'object',
      properties: {
        symbols: {
          type: 'string',
          description: 'One or more Taiwan securities, comma-separated. Codes (2330), English abbreviations (TSMC) and Chinese names (台積電) all resolve. Up to 20 per call.',
        },
      },
      required: ['symbols'],
    },
  },
  {
    name: 'taiwan_search_securities',
    description:
      'Find a Taiwan-listed security by company name, English abbreviation or numeric code across both the TWSE main board and the TPEx OTC board. Returns code, Chinese name, English abbreviation, market and sector — the lookup that turns "Foxconn" or "鴻海" into 2317 before pricing it.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Company name, English abbreviation, or numeric code. Partial matches work.' },
        market: { type: 'string', enum: ['all', 'twse', 'tpex'], description: 'Restrict to one board. Default all.' },
        limit: { type: 'number', description: 'Maximum matches to return, 1-100. Default 20.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'taiwan_company_profile',
    description:
      'Corporate profile of a TWSE-listed Taiwanese company from the exchange company master: English abbreviation, sector, chairman and president, incorporation and listing dates, paid-in capital, shares outstanding, registered address, auditor and website. Answers "who runs Foxconn", "when did TSMC list", "how many shares does 2330 have outstanding".',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'Company code (2330), English abbreviation (TSMC) or Chinese name (台積電).' },
      },
      required: ['symbol'],
    },
  },
  {
    name: 'taiwan_market_summary',
    description:
      'Daily level and change of the TAIEX (發行量加權股價指數, the Taiwan Stock Exchange benchmark) and the TPEx OTC index, with total market turnover, share volume and transaction count per session. Answers "where did the TAIEX close", "how is the Taiwan stock market doing", "Taiwan market turnover this week".',
    inputSchema: {
      type: 'object',
      properties: {
        days: { type: 'number', description: 'How many recent trading sessions to return, 1-30. Default 5.' },
      },
    },
  },
  {
    name: 'taiwan_stock_valuation',
    description:
      'Price-to-earnings ratio, dividend yield and price-to-book for Taiwan-listed shares, as published daily by TWSE and TPEx. Answers "what is TSMC trading at in P/E terms", "dividend yield on 2412", "is 2330 expensive".',
    inputSchema: {
      type: 'object',
      properties: {
        symbols: { type: 'string', description: 'One or more Taiwan securities, comma-separated. Codes, English abbreviations and Chinese names all resolve. Up to 20 per call.' },
      },
      required: ['symbols'],
    },
  },
  {
    name: 'taiwan_monthly_revenue',
    description:
      'Monthly sales (月營收) reported by TWSE-listed companies: the month\'s revenue with month-on-month and year-on-year change, plus year-to-date totals. Taiwan mandates this disclosure by the 10th of the following month, so it is the earliest read on semiconductor and electronics demand anywhere. Pass a company for its own filing, or a sector to rank companies by revenue growth.',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'Company code, English abbreviation or Chinese name. Omit to rank companies instead.' },
        industry: { type: 'string', description: 'Sector to rank within, e.g. "Semiconductor", "Shipping & Transportation". Omit for the whole market.' },
        limit: { type: 'number', description: 'How many companies to return when ranking, 1-100. Default 20.' },
      },
    },
  },
  {
    name: 'taiwan_material_news',
    description:
      'Mandatory same-day corporate disclosures (重大訊息) filed by TWSE-listed companies: board resolutions, mergers and acquisitions, large asset transactions, litigation, capital raises, name changes. Returns the filing company, timestamp, subject line and full statement text. Answers "what did Taiwanese companies announce today", "any TSMC announcements".',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'Restrict to one company by code, English abbreviation or Chinese name.' },
        query: { type: 'string', description: 'Keyword to match in the subject, statement text or company name (Chinese).' },
        limit: { type: 'number', description: 'Maximum announcements to return, 1-100. Default 20.' },
      },
    },
  },
  {
    name: 'taiwan_top_traded',
    description:
      'The twenty most heavily traded securities on the Taiwan Stock Exchange in the latest session, ranked by share volume, with each one\'s open, high, low, close and transaction count. Answers "what is being traded most in Taiwan", "most active Taiwanese stocks today".',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'How many of the twenty to return, 1-20. Default 20.' },
      },
    },
  },
  {
    name: 'taiwan_foreign_holdings',
    description:
      'How much of the Taiwan stock market foreign and mainland-China investors own, from the TWSE QFII register — either the securities with the highest overseas ownership and their remaining headroom under the statutory ceiling, or ownership share broken down by sector. Answers "how much of TSMC do foreigners own", "foreign ownership of Taiwanese banks".',
    inputSchema: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['top_holdings', 'by_industry'], description: 'top_holdings = the most foreign-owned securities. by_industry = ownership share per sector. Default top_holdings.' },
        limit: { type: 'number', description: 'Rows to return in top_holdings mode, 1-40. Default 20.' },
      },
    },
  },
  {
    name: 'taiwan_margin_balance',
    description:
      'Margin financing (融資) and short-sale (融券) balances for a Taiwan-listed stock, with the day\'s buys, sells, covering and the exchange quota. Rising margin balance means leveraged retail buying; rising short balance against a flat price is the classic squeeze setup. Answers "margin balance on 2330", "how heavily shorted is this Taiwanese stock".',
    inputSchema: {
      type: 'object',
      properties: {
        symbols: { type: 'string', description: 'One or more Taiwan securities, comma-separated. Codes, English abbreviations and Chinese names all resolve. Up to 20 per call.' },
      },
      required: ['symbols'],
    },
  },
  {
    name: 'taiwan_ex_dividend_calendar',
    description:
      'Announced ex-dividend and ex-rights dates for TWSE-listed securities, with the cash dividend per share, stock dividend ratio and any subscription terms. Answers "when does 2330 go ex-dividend", "which Taiwanese stocks go ex-dividend this month", "what is the dividend on 2412".',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'Restrict to one company by code, English abbreviation or Chinese name. Omit for the full forward calendar.' },
        limit: { type: 'number', description: 'Maximum entries to return, 1-200. Default 30.' },
      },
    },
  },
];

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  PROXY =
    typeof args._proxyUrl === 'string' && typeof args._proxyToken === 'string'
      ? { url: args._proxyUrl, token: args._proxyToken }
      : null;
  delete args._proxyUrl;
  delete args._proxyToken;
  switch (name) {
    case 'taiwan_stock_quote':
      return stockQuote(args);
    case 'taiwan_search_securities':
      return searchSecurities(args);
    case 'taiwan_company_profile':
      return companyProfile(args);
    case 'taiwan_market_summary':
      return marketSummary(args);
    case 'taiwan_stock_valuation':
      return stockValuation(args);
    case 'taiwan_monthly_revenue':
      return monthlyRevenue(args);
    case 'taiwan_material_news':
      return materialNews(args);
    case 'taiwan_top_traded':
      return topTraded(args);
    case 'taiwan_foreign_holdings':
      return foreignHoldings(args);
    case 'taiwan_margin_balance':
      return marginBalance(args);
    case 'taiwan_ex_dividend_calendar':
      return exDividendCalendar(args);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
