// A placeholder or a template slot in the password position is not a secret.
const PLACEHOLDER_PASSWORD =
  /^(?:\$\{|\$[A-Z_]|<|\[|%|\*+$|x+$|(?:your[-_]?)?(?:password|passwd|pass|pwd|secret)$|example$|changeme$)/i;
// Neither is the password of a database on the machine the code itself runs on.
const LOOPBACK_HOST = /^(?:localhost|127\.|0\.0\.0\.0)/i;

// How every pattern below is written: runs are `x{n}x*`, not `x{n,}`, because V8 keeps a
// backtrack record per repetition of the counted form and overflows its stack on a
// multi-megabyte base64 run such as an inline map. `accepts` and `redact` receive the whole
// regex match; `accepts` also receives the test a pattern without one gets, to build on.
// `inBytes` says what differs where bytes that are not text are searched, and `false`
// there leaves the pattern out.

// A database or queue address that carries its password. Only the host is shown back.
// It has a name of its own because values from `.env` are tested against it as well.
const CONNECTION_STRING = {
  id: 'connection-string',
  severity: 'critical',
  regex:
    /\b(postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|rediss?|amqps?):\/\/[^\s:@/"'`\\]{1,128}:([^\s@/"'`\\]{1,256})@([A-Za-z0-9.-]{1,253})/g,
  accepts: ([, , password, host]) => !PLACEHOLDER_PASSWORD.test(password) && !LOOPBACK_HOST.test(host),
  redact: ([, scheme, , host]) => `${scheme}://…@${host}`,
};

// A stand-in written as a run of one character, such as the Slack webhook address in Slack's
// own documentation, which ends in twenty-four X, is no key. The random part of each key below
// is at its end, and twenty random characters hold far more than six different ones.
const VARIED_CHARACTERS = 20;
const MIN_VARIETY = 6;
// Neither is one written as a counting run, as sentry-cli's own help writes a user token.
const COUNTING_RUN = /0123456|1234567|abcdefg/i;
// The start of the account key of Azure's storage emulator, which Microsoft publishes for anyone to use.
const AZURE_EMULATOR_KEY_START = 'AccountKey=Eby8vdM02xNOcqFlqUwJ';

/** @param {string} [trusted] the part of the match that is certainly the key: all of it, except in bytes */
function looksIssued(match, isNotAStandIn, trusted = match[0]) {
  return isNotAStandIn(match) && new Set(trusted.slice(-VARIED_CHARACTERS)).size >= MIN_VARIETY && !COUNTING_RUN.test(trusted);
}

/** A key an app calls its service with while it runs, looked for in text and in bytes alike. */
function serverKey(id, regex, more) {
  return { id, severity: 'critical', regex, accepts: looksIssued, ...more };
}

/**
 * A key looked for in text alone: one for publishing, deploying or running servers, which sits
 * in settings files and scripts, or one whose prefix the names in a program spell. In bytes,
 * where strings run into each other, none of the 71 matches of such kinds across the programs
 * of /Applications was a key issued for the app: 61 were names, as `tfp_8sanitize` and
 * `re_arguments_`, or stand-ins. And every kind searched in bytes costs time on every
 * program: six more of them made the search half as long again.
 */
function textKey(id, regex, more) {
  return serverKey(id, regex, { ...more, inBytes: false });
}

// Server keys of more services, each told by the prefix it is issued with. The formats are
// those the vendors document where they do, and otherwise those that the rules of gitleaks
// and the detectors of trufflehog record. Keys a browser is meant to hold, such as PostHog's
// project key (phc_) and Mapbox's public token (pk.), are left out, and so are prefixes too
// short to tell a key from other text by (Twilio's SK, Mailgun's key-, Google's AIza, which
// its browser keys share).
const MORE_SERVER_KEYS = [
  // AI services.
  serverKey('xai-key', /\bxai-[0-9A-Za-z_]{80}\b/g),
  serverKey('groq-key', /\bgsk_[A-Za-z0-9]{52}\b/g),
  serverKey('openrouter-key', /\bsk-or-v1-[0-9a-f]{64}\b/g),
  textKey('replicate-token', /\br8_[0-9A-Za-z]{37}\b/g),
  serverKey('perplexity-key', /\bpplx-[A-Za-z0-9]{48}\b/g),
  // Made of letters alone, which Apple's Home app spells out twice in bytes.
  textKey('huggingface-token', /\b(?:hf_|api_org_)[A-Za-z]{34}\b/g),
  textKey('nvidia-key', /\bnvapi-[A-Za-z0-9_-]{64}[A-Za-z0-9_-]*/g),
  textKey('pinecone-key', /\bpcsk_[A-Za-z0-9]{6}_[A-Za-z0-9]{60}[A-Za-z0-9]*/g),
  textKey('langsmith-key', /\blsv2_(?:pt|sk)_[a-f0-9]{32}_[a-f0-9]{10}\b/g),
  textKey('langfuse-secret', /\bsk-lf-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g),
  // Messages and mail. Slack's tokens, as its documentation lays them out, are numbers and a
  // secret, set apart by dashes. A webhook address lets anyone post where it leads, and nothing
  // more; it is shown back up to the secret, which is its last part.
  serverKey(
    'slack-token',
    /\b(?:xoxb-[0-9]{10}[0-9]*-[0-9]{10}[0-9]*-[A-Za-z0-9]{24}[A-Za-z0-9]*|xox[pe](?:-[0-9]{10}[0-9]*){3}-[A-Za-z0-9]{28}[A-Za-z0-9]*|xapp-[0-9]-[A-Z0-9]{9}[A-Z0-9]*-[0-9]{10}[0-9]*-[a-z0-9]{32}[a-z0-9]*)/g,
  ),
  serverKey('slack-webhook', /hooks\.slack\.com\/(?:services|workflows|triggers)\/[A-Za-z0-9+/]{43}[A-Za-z0-9+/]*/g, {
    severity: 'high',
    redact: ([value]) => `${/^hooks\.slack\.com\/\w+\/[A-Z0-9]+\/[A-Z0-9]+\//.exec(value)?.[0] ?? 'hooks.slack.com/'}…`,
  }),
  serverKey('discord-webhook', /discord(?:app)?\.com\/api\/webhooks\/[0-9]{17}[0-9]*\/[A-Za-z0-9_-]{60}[A-Za-z0-9_-]*/g, {
    severity: 'high',
    redact: ([value]) => `${/^discord(?:app)?\.com\/api\/webhooks\/[0-9]+\//.exec(value)[0]}…`,
  }),
  serverKey('sendgrid-key', /\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}/g),
  serverKey('brevo-key', /\bxkeysib-[a-f0-9]{64}-[A-Za-z0-9]{16}\b/g),
  textKey('resend-key', /\bre_[1-9A-HJ-NP-Za-km-z]{8}_[1-9A-HJ-NP-Za-km-z]{24}\b/g),
  // Payments and shops. Stripe's documentation says its signing secrets begin with whsec_, and
  // the webhooks of Clerk and Resend, sent by Svix, use the same.
  serverKey('webhook-secret', /\bwhsec_[A-Za-z0-9+/=]{32}[A-Za-z0-9+/=]*/g),
  serverKey('shopify-token', /\bshp(?:at|ca|pa|ss)_[a-fA-F0-9]{32}\b/g),
  serverKey('square-token', /\bsq0(?:atp|csp)-[0-9A-Za-z_-]{22}[0-9A-Za-z_-]*/g),
  // Code, packages and the tools teams work in. GitLab's prefixes are those of its token documentation.
  textKey(
    'gitlab-token',
    /\b(?:gl(?:pat|dt|rt|rtr|ptt|ft|imt|agent|oas|soat|ffct|wt)-[0-9A-Za-z_-]{20}[0-9A-Za-z_-]*|glcbt-[0-9A-Za-z]{1,5}_[0-9A-Za-z_-]{20}[0-9A-Za-z_-]*)/g,
  ),
  textKey('npm-token', /\bnpm_[A-Za-z0-9]{36}\b/g),
  textKey('pypi-token', /\bpypi-AgEIcHlwaS5vcmc[A-Za-z0-9_-]{50}[A-Za-z0-9_-]*/g),
  textKey('rubygems-key', /\brubygems_[a-f0-9]{48}\b/g),
  textKey('docker-token', /\bdckr_pat_[A-Za-z0-9_-]{27}/g),
  textKey('postman-key', /\bPMAK-[a-f0-9]{24}-[a-f0-9]{34}\b/g),
  textKey('linear-key', /\blin_api_[A-Za-z0-9]{40}\b/g),
  textKey('notion-token', /\bntn_[0-9]{11}[A-Za-z0-9]{35}\b/g),
  textKey('airtable-token', /\bpat[A-Za-z0-9]{14}\.[a-f0-9]{64}\b/g),
  textKey('atlassian-token', /\bATATT3[A-Za-z0-9_=-]{180}[A-Za-z0-9_=-]*/g),
  textKey('contentful-token', /\bCFPAT-[A-Za-z0-9_-]{43}/g),
  textKey('typeform-token', /\btfp_[A-Za-z0-9_.=-]{59}/g),
  // Hosting, databases and the services that run them.
  textKey('supabase-access-token', /\bsbp_[a-z0-9]{40}\b/g),
  textKey('digitalocean-token', /\bdo[opr]_v1_[a-f0-9]{64}\b/g),
  textKey('planetscale-token', /\bpscale_(?:tkn|oauth|pw)_[A-Za-z0-9_=.-]{32}[A-Za-z0-9_=.-]*/g),
  textKey('heroku-key', /\bHRKU-AA[0-9A-Za-z_-]{58}/g),
  textKey('flyio-token', /\b(?:fo1_[A-Za-z0-9_-]{43}|fm[12][ar]?_[A-Za-z0-9+/]{100}[A-Za-z0-9+/]*={0,3})/g),
  textKey('deno-token', /\bdd[pw]_[A-Za-z0-9]{36}\b/g),
  textKey('databricks-token', /\bdapi[a-f0-9]{32}\b/g),
  textKey('doppler-token', /\bdp\.(?:pt|st|sa|ct)\.[A-Za-z0-9]{40}[A-Za-z0-9]*/g),
  textKey('vault-token', /\bhv[sb]\.[A-Za-z0-9_-]{90}[A-Za-z0-9_-]*/g),
  textKey('tailscale-key', /\btskey-[a-z]{3,7}-[0-9A-Za-z]{6}[0-9A-Za-z]*-[0-9A-Za-z]{20}[0-9A-Za-z]*/g),
  textKey('pulumi-token', /\bpul-[a-f0-9]{40}\b/g),
  textKey('cloudflare-origin-ca-key', /\bv1\.0-[a-f0-9]{24}-[a-f0-9]{146}\b/g),
  textKey('onepassword-token', /\bops_eyJ[A-Za-z0-9+/]{250}[A-Za-z0-9+/]*={0,3}/g),
  textKey('age-key', /\bAGE-SECRET-KEY-1[QPZRY9X8GF2TVDW0S3JN54KHCE6MUA7L]{58}\b/g),
  // An Alibaba Cloud key ID: four Go programs in Homebrew hold the same one in bytes.
  textKey('alibaba-access-key', /\bLTAI[A-Za-z0-9]{20}\b/g, { severity: 'high' }),
  textKey('azure-key', /\b(?:AccountKey=[A-Za-z0-9+/]{86}==|SharedAccessKey=[A-Za-z0-9+/]{43}=)/g, {
    accepts: (match, ...rest) => looksIssued(match, ...rest) && !match[0].startsWith(AZURE_EMULATOR_KEY_START),
  }),
  // Watching and measuring.
  textKey('sentry-token', /\b(?:sntryu_[a-f0-9]{64}\b|sntrys_eyJpYXQiO[A-Za-z0-9+/=_]{40}[A-Za-z0-9+/=_]*)/g),
  textKey('grafana-token', /\b(?:glsa_[A-Za-z0-9]{32}_[A-Fa-f0-9]{8}\b|glc_[A-Za-z0-9+/]{32}[A-Za-z0-9+/]*={0,3})/g),
  textKey('newrelic-key', /\bNRAK-[A-Za-z0-9]{27}\b/g),
  textKey('dynatrace-token', /\bdt0c01\.[A-Za-z0-9]{24}\.[A-Za-z0-9]{64}\b/g),
  textKey('posthog-personal-key', /\bphx_[A-Za-z0-9_]{43}[A-Za-z0-9_]*/g),
  serverKey('mapbox-secret', /\bsk\.eyJ[A-Za-z0-9_-]{20}[A-Za-z0-9_-]*\.[A-Za-z0-9_-]{20}[A-Za-z0-9_-]*/g),
];

// Prefixes come from each vendor's key documentation. Publishable keys (pk_, sb_publishable_)
// are meant for browsers and are deliberately absent.
const SECRET_PATTERNS = [
  { id: 'stripe-live', severity: 'critical', regex: /\b(?:sk|rk)_live_[A-Za-z0-9]{16}[A-Za-z0-9]*\b/g },
  { id: 'stripe-test', severity: 'high', regex: /\b(?:sk|rk)_test_[A-Za-z0-9]{16}[A-Za-z0-9]*\b/g },
  { id: 'supabase-secret', severity: 'critical', regex: /\bsb_secret_[A-Za-z0-9_-]{16}[A-Za-z0-9_-]*/g },
  {
    id: 'github-token',
    severity: 'critical',
    regex: /\b(?:gh[pousr]_[A-Za-z0-9]{30}[A-Za-z0-9]*|github_pat_[A-Za-z0-9_]{30}[A-Za-z0-9_]*)\b/g,
  },
  {
    id: 'aws-access-key',
    severity: 'high',
    regex: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
    inBytes: { accepts: (match, isNotAStandIn) => isNotAStandIn(match) && !isSpelledByEncodedData(match) },
  },
  {
    // Crypto libraries carry the bare header as a string. Only a header followed by key
    // material is a key; in a string literal the line break before it is an escaped one.
    id: 'private-key',
    severity: 'critical',
    regex: /-----BEGIN ((?:[A-Z]+ )?)PRIVATE KEY-----(?:\\[rn]|\s)*[A-Za-z0-9+/]{40}/g,
    redact: ([, keyType]) => `-----BEGIN ${keyType}PRIVATE KEY-----`,
    // TLS libraries such as GnuTLS compile their self-test keys into programs, in the same
    // PEM form, so in bytes one is far more often theirs than the app's.
    inBytes: false,
  },
  // Not a documented format guarantee: these are the prefixes the vendors currently issue. An
  // OpenAI key from before project keys has the word OpenAI in base64 (T3BlbkFJ) in its middle.
  {
    id: 'ai-api-key',
    severity: 'critical',
    regex: /\bsk-(?:(?:ant|proj|svcacct|admin)-[A-Za-z0-9_-]{20}[A-Za-z0-9_-]*|[A-Za-z0-9]{20}T3BlbkFJ[A-Za-z0-9]{20}\b)/g,
  },
  CONNECTION_STRING,
  {
    // Supabase's legacy keys are JWTs told apart by the `role` claim: `anon` is meant for
    // browsers, `service_role` bypasses row level security.
    // The lookbehind skips an `eyJ` that has an earlier start in the same unbroken run. That
    // start reads to the same dot, so trying again from here can find nothing new, and
    // without the skip a long run of `-eyJ...` pieces is read again from every piece.
    id: 'supabase-service-role',
    severity: 'critical',
    regex:
      /\beyJ(?<!\beyJ[A-Za-z0-9_-]*?eyJ)[A-Za-z0-9_-]{8}[A-Za-z0-9_-]*\.eyJ[A-Za-z0-9_-]{8}[A-Za-z0-9_-]*\.[A-Za-z0-9_-]{8}[A-Za-z0-9_-]*/g,
    accepts: isSupabaseServiceRoleJwt,
  },
  ...MORE_SERVER_KEYS,
];
// One file full of key-shaped text is noise or an attack, not that many keys. A search stops
// here, and so does a file read a stretch at a time.
export const MAX_KEYS_IN_A_FILE = 200;

/**
 * How a set of patterns is searched for: the patterns, one combined pattern that rules out
 * most text in a single pass (most shipped files hold no key at all), and how much of a
 * match is the key itself, to be judged and partly shown back.
 *
 * @param {object} head how far into a match the key itself certainly reaches
 * @param {number} head.judged for telling a stand-in
 * @param {number} head.same for telling one key from another
 * @param {(value: string) => string} redact keeps enough of a key to recognise it without reprinting it
 */
function prepareSearch(patterns, head, redact) {
  const anySecret = new RegExp(anyOf(patterns).source, 'g');
  // Documentation and self-tests write stand-in keys with this word in them, as AWS does in
  // AKIAIOSFODNN7EXAMPLE. No issued key spells it out by chance.
  const isNotAStandIn = ([value]) => !/example/i.test(value.slice(0, head.judged));
  // Each pattern is also tried at a given place alone, where the combined one matched.
  const tried = patterns.map((pattern) => ({ ...pattern, atPlace: new RegExp(pattern.regex.source, 'y') }));
  return { patterns: tried, anySecret, isNotAStandIn, sameLength: head.same, redact: ([value]) => redact(value) };
}

// Past this many places where the combined pattern matches, each pattern searches the whole
// text instead: trying one place costs about as much as searching 230 characters.
const MAX_PLACES = 1000;

/** @returns {number[] | null} where in the text some pattern matches, or null for more than the limit */
function placesOf(anySecret, text) {
  const places = [];
  anySecret.lastIndex = 0;
  for (let found = anySecret.exec(text); found; found = anySecret.exec(text)) {
    if (places.length === MAX_PLACES) return null;
    places.push(found.index);
    anySecret.lastIndex = found.index + 1;
  }
  return places;
}

/** What `text.matchAll` gives for a pattern, found by trying it only at the places given. */
function* matchesAt(atPlace, text, places) {
  let from = 0;
  for (const place of places) {
    if (place < from) continue;
    atPlace.lastIndex = place;
    const match = atPlace.exec(text);
    if (!match) continue;
    from = place + match[0].length;
    yield match;
  }
}

/**
 * One pattern that holds wherever any of `patterns` does, written to be quick to rule out. A
 * regular expression tries each of its choices in turn at every place in the text, so a choice
 * a pattern opens with is taken apart, the openings that start with the same character become
 * one choice that tries them after it, and those at the start of a word share that one test.
 */
function anyOf(patterns) {
  const atWordStart = new Map();
  const anywhere = new Map();
  const others = [];
  for (const source of patterns.flatMap(({ regex }) => openingsOf(regex.source))) {
    const opening = /^(\\b)?([A-Za-z0-9-])(?![*+?{])/.exec(source);
    if (!opening || choicesOf(source).length > 1) {
      others.push(`(?:${source})`);
      continue;
    }
    const [head, boundary, character] = opening;
    const byCharacter = boundary ? atWordStart : anywhere;
    byCharacter.set(character, [...(byCharacter.get(character) ?? []), `(?:${source.slice(head.length)})`]);
  }
  const choices = (byCharacter) => [...byCharacter].map(([character, rests]) => `${character}(?:${rests.join('|')})`);
  const wordStart = atWordStart.size > 0 ? [`\\b(?:${choices(atWordStart).join('|')})`] : [];
  return new RegExp([...wordStart, ...choices(anywhere), ...others].join('|'));
}

/** A pattern's source as one for each choice it opens with: `\b(?:sk|rk)_live_` as `\bsk_live_` and `\brk_live_`. */
function openingsOf(source) {
  const boundary = source.startsWith('\\b') ? '\\b' : '';
  const rest = source.slice(boundary.length);
  // A group that is not a lookaround, and that no count follows.
  const group = /^\((?:\?:)?(?!\?)/.exec(rest);
  if (!group) return [source];
  const choices = choicesOf(rest.slice(group[0].length));
  // Joined back, the choices are what the group holds, so its `)` comes right after them.
  const after = rest.slice(group[0].length + choices.join('|').length + 1);
  if (/^[*+?{]/.test(after)) return [source];
  return choices.map((choice) => `${boundary}${choice}${after}`);
}

/**
 * The fewest characters a match of a pattern's source can have. In bytes it is the part of a
 * match that is certainly the key: what follows may be whatever was stored next.
 */
function fixedLength(source) {
  const choices = choicesOf(source);
  if (choices.length > 1) return Math.min(...choices.map(fixedLength));
  let total = 0;
  for (let at = 0; at < source.length; ) {
    let atom = 1;
    if (source[at] === '\\') {
      atom = /[bB]/.test(source[at + 1]) ? 0 : 1;
      at += 2;
    } else if (source[at] === '[') {
      let end = at + 1;
      while (source[end] !== ']') end += source[end] === '\\' ? 2 : 1;
      at = end + 1;
    } else if (source[at] === '(') {
      // A lookaround matches no character of its own.
      const [opening] = /^\((?:\?(?::|<?[=!]))?/.exec(source.slice(at));
      const inside = choicesOf(source.slice(at + opening.length));
      atom = /[=!]$/.test(opening) ? 0 : Math.min(...inside.map(fixedLength));
      at += opening.length + inside.join('|').length + 1;
    } else {
      at += 1;
    }
    const count = /^(?:[*?+]|\{(\d+)(?:,\d*)?\})\??/.exec(source.slice(at));
    if (count) {
      atom *= '*?'.includes(count[0][0]) ? 0 : count[0][0] === '+' ? 1 : Number(count[1]);
      at += count[0].length;
    }
    total += atom;
  }
  return total;
}

/** The choices of a source at its top level, outside any group, up to the `)` of a group it is inside. */
function choicesOf(source) {
  const choices = [];
  let depth = 0;
  let isInClass = false;
  let start = 0;
  for (let at = 0; at < source.length; at += 1) {
    const character = source[at];
    if (character === '\\') at += 1;
    else if (isInClass) isInClass = character !== ']';
    else if (character === '[') isInClass = true;
    else if (character === '(') depth += 1;
    else if (character === ')' && --depth < 0) return [...choices, source.slice(start, at)];
    else if (character === '|' && depth === 0) {
      choices.push(source.slice(start, at));
      start = at + 1;
    }
  }
  return [...choices, source.slice(start)];
}

// In text a match ends where the key ends.
const TEXT_SEARCH = prepareSearch(
  SECRET_PATTERNS,
  { judged: Infinity, same: Infinity },
  (value) => `${value.slice(0, 8)}…${value.slice(-4)}`,
);
// An AWS key ID is the one pattern here made of capitals and digits alone, and base64 text
// is full of those, so in bytes encoded data spells one out by chance. Two cases turned up
// in real files. The WebAssembly that Node.js carries as base64 runs for megabytes without
// a break: a match with this much base64 on both sides of it is part of such a run. A font
// kept as base64 in Python bytecode is mostly zero bytes, which come out as one letter over
// and over: of key IDs drawn at random, one in four thousand has fewer than ten different
// characters. In text neither case gets this far, because a key has to stand apart there.
const ENCODED_REACH = 100;
const ENCODED_STRETCH = new RegExp(`^[A-Za-z0-9+/]{${ENCODED_REACH}}$`);
const MIN_DIFFERENT_CHARACTERS = 10;

function isSpelledByEncodedData({ 0: value, index, input }) {
  if (new Set(value).size < MIN_DIFFERENT_CHARACTERS) return true;
  const end = index + value.length;
  return (
    index >= ENCODED_REACH &&
    ENCODED_STRETCH.test(input.slice(index - ENCODED_REACH, index)) &&
    ENCODED_STRETCH.test(input.slice(end, end + ENCODED_REACH))
  );
}

// How far from an edge of a stretch a match has to be for that stretch to judge it: whole,
// and with what stands around it. Nearer than this, the stretch next to it has it so,
// which holds as long as the two overlap by more than this twice over plus the longest key.
const EDGE_CHARACTERS = ENCODED_REACH;

// In the bytes of a program or of bytecode, strings are often stored end to end with nothing
// between them (Rust, Go and Hermes do). A key need not start at a word boundary there, and
// a match can run on into whatever was stored next, so only its head counts: what every match
// of its pattern holds, and at least 24 characters, the shortest key these patterns take, to
// tell one key from another, and 40, within which a stand-in says it is one.
const BYTE_SEARCH = prepareSearch(
  SECRET_PATTERNS.filter(({ inBytes }) => inBytes !== false).map(({ inBytes, ...pattern }) => {
    const source = pattern.regex.source.replaceAll('\\b', '');
    return { ...pattern, ...inBytes, regex: new RegExp(source, 'g'), trustedLength: fixedLength(source) };
  }),
  { judged: 40, same: 24 },
  (value) => `${value.slice(0, 12)}…`,
);

/**
 * Where a stretch of a file sits in it: whether the file goes on before and after.
 *
 * @typedef {{ hasMoreBefore: boolean, hasMoreAfter: boolean }} Place
 */
const WHOLE_FILE = { hasMoreBefore: false, hasMoreAfter: false };

/**
 * Finds server-only keys in the text of one shipped file, or of one stretch of it. Nothing
 * it returns contains a whole secret.
 *
 * @param {Place} [place]
 * @param {Set<string>} [seen] the keys already found in this file, kept by the caller from
 *   one stretch to the next so that a key met again is not reported again
 */
export function checkSecrets(path, text, place = WHOLE_FILE, seen = new Set()) {
  return search(TEXT_SEARCH, path, text, place, seen);
}

/** The same search over a stretch of bytes that are not text, read as the text they may hold. */
export function checkSecretsInBytes(path, text, place, seen) {
  return search(BYTE_SEARCH, path, text, place, seen);
}

function search({ patterns, anySecret, isNotAStandIn, sameLength, redact: redactHead }, path, text, place, seen) {
  // Most shipped files hold no key at all, and are done with in one pass. A key can start only
  // where the combined pattern matches, so each pattern is tried there and not all over.
  const places = placesOf(anySecret, text);
  if (places?.length === 0) return [];

  const findings = [];
  for (const { id, severity, regex, atPlace, accepts = isNotAStandIn, redact = redactHead, trustedLength = Infinity } of patterns) {
    for (const match of places ? matchesAt(atPlace, text, places) : text.matchAll(regex)) {
      const [value] = match;
      // At an edge where the file goes on, a match may be cut in two or stand without what
      // is around it. It is left to the stretch next to this one.
      if (place.hasMoreBefore && match.index < EDGE_CHARACTERS) continue;
      if (place.hasMoreAfter && match.index + value.length + EDGE_CHARACTERS > text.length) continue;
      const key = value.slice(0, Math.max(sameLength, trustedLength));
      if (seen.has(key) || !accepts(match, isNotAStandIn, value.slice(0, trustedLength))) continue;
      // A name in code can hold a key's opening by chance, as `risk_live_` does. Stuck to
      // the end of another word, a match counts only with a digit in it, which a name of
      // that kind lacks and an issued key all but always has.
      const isStuckToAWord = match.index > 0 && /\w/.test(text[match.index - 1]);
      if (isStuckToAWord && !/\d/.test(value)) continue;
      // Cut out of the text, the key is a view into it: kept as it is, it would keep the
      // whole stretch in memory for as long as the file is being searched.
      seen.add(structuredClone(key));
      findings.push({ rule: 'secret', severity, path, detail: { secretId: id, redacted: redact(match) } });
      if (findings.length === MAX_KEYS_IN_A_FILE) return findings;
    }
  }
  return findings;
}

/** Whether a value is a database or queue address with a real password in it. */
export function isCredentialAddress(value) {
  return Array.from(value.matchAll(CONNECTION_STRING.regex)).some((match) => CONNECTION_STRING.accepts(match));
}

function isSupabaseServiceRoleJwt([token]) {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    return payload?.role === 'service_role';
  } catch {
    return false;
  }
}
