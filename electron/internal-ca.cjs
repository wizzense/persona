"use strict";

/** internal-ca — the ONE resolver for the AitherNet CA chain awdesk trusts.
 *
 *  Three modules (safety-gate, relay-feed, surfaces) each carried their own copy of this
 *  lookup, and every copy had the same two defects, measured 2026-09-19:
 *
 *  1. The env branch was DEAD. It joined `AITHEROS_ROOT/Library/Data/tls`, but the chain
 *     lives under the monorepo's `AitherOS/` subtree (`lib/security/TLSConfig.py` ->
 *     `AitherOS/Library/Data/tls/ca-chain.pem`), so with AITHEROS_ROOT set to the checkout
 *     root the candidate never existed and the literal fallbacks below did all the work.
 *  2. Those fallbacks were the operator's own drive paths, hard-coded. They ship through the
 *     public lane (Aitherium/awdesk mirrors this tree), where they resolve to nothing and
 *     name the operator's layout out loud. The boundary guard greps for hosts and debt ids,
 *     not for `C:\...`, so nothing caught it.
 *
 *  Resolution order, first readable file wins:
 *    DESK_INTERNAL_CA                      an explicit file (the override)
 *    AITHEROS_ROOT/AitherOS/Library/Data/tls/ca-chain.pem   the monorepo layout
 *    AITHEROS_ROOT/Library/Data/tls/ca-chain.pem            a flattened deploy
 *    AITHEROS_DATA/tls/ca-chain.pem                         the data root the python side uses
 *    ~/.aither/ca-chain.pem                                 a per-user copy
 *
 *  No candidate is a literal drive path: a machine that is not the operator's has to say
 *  where its chain is, and a machine that has none gets `undefined`, which every caller
 *  already treats as "use the system store".
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const CHAIN = path.join("Library", "Data", "tls", "ca-chain.pem");

function candidates(env = process.env, home = os.homedir()) {
  const out = [];
  if (env.DESK_INTERNAL_CA) out.push(env.DESK_INTERNAL_CA);
  if (env.AITHEROS_ROOT) {
    out.push(path.join(env.AITHEROS_ROOT, "AitherOS", CHAIN));
    out.push(path.join(env.AITHEROS_ROOT, CHAIN));
  }
  if (env.AITHEROS_DATA) out.push(path.join(env.AITHEROS_DATA, "tls", "ca-chain.pem"));
  if (home) out.push(path.join(home, ".aither", "ca-chain.pem"));
  return out;
}

/** The CA chain as a Buffer, or undefined when no candidate is readable. */
function internalCaBuffer(env = process.env, home = os.homedir()) {
  for (const p of candidates(env, home)) {
    try {
      if (fs.existsSync(p)) return fs.readFileSync(p);
    } catch {
      // an unreadable candidate is simply not the CA — try the next
    }
  }
  return undefined;
}

/** `{ ca }` for spreading into https options, or `{}` when there is no chain. */
function internalCaOptions(env = process.env, home = os.homedir()) {
  const ca = internalCaBuffer(env, home);
  return ca ? { ca } : {};
}

module.exports = { candidates, internalCaBuffer, internalCaOptions };
