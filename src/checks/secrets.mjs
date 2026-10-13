// A placeholder or a template slot in the password position is not a secret.
const PLACEHOLDER_PASSWORD =
  /^(?:\$\{|\$[A-Z_]|<|\[|%|\*+$|x+$|(?:your[-_]?)?(?:password|passwd|pass|pwd|secret)$|example$|changeme$)/i;

// How every pattern below is written: runs are `x{n}x*`, not `x{n,}`, because V8 keeps a
// backtrack record per repetition of the counted form and overflows its stack on a
// multi-megabyte base64 run such as an inline map. `accepts` and `redact` receive the whole
// regex match.

// A database or queue address that carries its password. Only the host is shown back.
// It has a name of its own because values from `.env` are tested against it as well.
const CONNECTION_STRING = {
  id: 'connection-string',
  severity: 'critical',
  regex:
    /\b(postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|rediss?|amqps?):\/\/[^\s:@/"'`\\]{1,128}:([^\s@/"'`\\]{1,256})@([A-Za-z0-9.-]{1,253})/g,
  accepts: ([, , password]) => !PLACEHOLDER_PASSWORD.test(password),
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
  { id: 'aws-access-key', severity: 'high', regex: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
  {
    // Crypto libraries carry the bare header as a string. Only a header followed by key
    // material is a key; in a string literal the line break before it is an escaped one.
    id: 'private-key',
    severity: 'critical',
    regex: /-----BEGIN ((?:[A-Z]+ )?)PRIVATE KEY-----(?:\\[rn]|\s)*[A-Za-z0-9+/]{40}/g,
    redact: ([, keyType]) => `-----BEGIN ${keyType}PRIVATE KEY-----`,
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
// Most shipped files hold no key at all, so one pass rules them out before the per-kind passes.
const ANY_SECRET = new RegExp(SECRET_PATTERNS.map(({ regex }) => `(?:${regex.source})`).join('|'));

/** Finds server-only keys in one shipped text file. Nothing it returns contains a whole secret. */
export function checkSecrets(path, text) {
  if (!ANY_SECRET.test(text)) return [];

  const seen = new Set();
  const findings = [];
  for (const { id, severity, regex, accepts, redact = redactValue } of SECRET_PATTERNS) {
    for (const match of text.matchAll(regex)) {
      const [value] = match;
      if (seen.has(value) || (accepts && !accepts(match))) continue;
      seen.add(value);
      findings.push({ rule: 'secret', severity, path, detail: { secretId: id, redacted: redact(match) } });
    }
  }
  return findings;
}

/** Whether a value is a database or queue address with a real password in it. */
export function isCredentialAddress(value) {
  return Array.from(value.matchAll(CONNECTION_STRING.regex)).some(CONNECTION_STRING.accepts);
}

function isSupabaseServiceRoleJwt([token]) {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    return payload?.role === 'service_role';
  } catch {
    return false;
  }
}

/** Keeps enough of a secret to recognise it without reprinting it in a report. */
function redactValue([value]) {
  return `${value.slice(0, 8)}…${value.slice(-4)}`;
}
