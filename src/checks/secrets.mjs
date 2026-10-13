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
  // Not a documented format guarantee: these are the prefixes the vendors currently issue.
  { id: 'ai-api-key', severity: 'critical', regex: /\bsk-(?:ant|proj)-[A-Za-z0-9_-]{20}[A-Za-z0-9_-]*/g },
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
];
// One file full of key-shaped text is noise or an attack, not that many keys.
const MAX_FINDINGS_PER_SEARCH = 200;

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
  const anySecret = new RegExp(patterns.map(({ regex }) => `(?:${regex.source})`).join('|'));
  // Documentation and self-tests write stand-in keys with this word in them, as AWS does in
  // AKIAIOSFODNN7EXAMPLE. No issued key spells it out by chance.
  const isNotAStandIn = ([value]) => !/example/i.test(value.slice(0, head.judged));
  return { patterns, anySecret, isNotAStandIn, sameLength: head.same, redact: ([value]) => redact(value) };
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
// a match can run on into whatever was stored next, so only its head counts: 24 characters
// are the shortest key these patterns take, and a stand-in says so within 40.
const BYTE_SEARCH = prepareSearch(
  SECRET_PATTERNS.filter(({ inBytes }) => inBytes !== false).map(({ inBytes, ...pattern }) => ({
    ...pattern,
    ...inBytes,
    regex: new RegExp(pattern.regex.source.replaceAll('\\b', ''), 'g'),
  })),
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
  if (!anySecret.test(text)) return [];

  const findings = [];
  for (const { id, severity, regex, accepts = isNotAStandIn, redact = redactHead } of patterns) {
    for (const match of text.matchAll(regex)) {
      const [value] = match;
      // At an edge where the file goes on, a match may be cut in two or stand without what
      // is around it. It is left to the stretch next to this one.
      if (place.hasMoreBefore && match.index < EDGE_CHARACTERS) continue;
      if (place.hasMoreAfter && match.index + value.length + EDGE_CHARACTERS > text.length) continue;
      const key = value.slice(0, sameLength);
      if (seen.has(key) || !accepts(match, isNotAStandIn)) continue;
      // A name in code can hold a key's opening by chance, as `risk_live_` does. Stuck to
      // the end of another word, a match counts only with a digit in it, which a name of
      // that kind lacks and an issued key all but always has.
      const isStuckToAWord = match.index > 0 && /\w/.test(text[match.index - 1]);
      if (isStuckToAWord && !/\d/.test(value)) continue;
      // Cut out of the text, the key is a view into it: kept as it is, it would keep the
      // whole stretch in memory for as long as the file is being searched.
      seen.add(structuredClone(key));
      findings.push({ rule: 'secret', severity, path, detail: { secretId: id, redacted: redact(match) } });
      if (findings.length === MAX_FINDINGS_PER_SEARCH) return findings;
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

