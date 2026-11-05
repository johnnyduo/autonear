// Build attestation: records the output of a REAL build + test run (done by scripts/attest.mjs locally or in CI).
// The server cannot build contracts (no toolchain on serverless), so it only accepts, hashes and later cross-checks attestations.
import { sha256, now, j, putBlob, audit } from './db.js';
import { validate, PolicyError } from './policy.js';

const SCHEMA = {
  type: 'object', required: ['protocol', 'manifest', 'tests'],
  properties: {
    protocol: { enum: ['near', 'evm'] },
    manifest: { type: 'object', required: ['sha256', 'bytes', 'sourceSha256'] },
    tests: { type: 'object', required: ['passed', 'failed'], properties: { passed: { type: 'number', min: 0 }, failed: { type: 'number', min: 0 } } },
    commitSha: { type: 'string' },
  },
};

export async function recordAttestation(db, att, actor = 'ci') {
  validate(SCHEMA, att);
  if (!/^[0-9a-f]{64}$/.test(att.manifest.sha256)) throw new PolicyError('manifest.sha256 must be 64 hex chars', 'schema');
  if (att.tests.failed !== 0 || att.tests.passed < 1) throw new PolicyError('attestation rejected: the build must have passing tests and zero failures', 'attestation');
  if (att.tests.lint !== true) throw new PolicyError('attestation rejected: lint/format checks must pass', 'attestation');
  if (!Array.isArray(att.tests.names) || att.tests.names.length < 1) throw new PolicyError('attestation rejected: test names are required for the security review', 'attestation');
  if (att.protocol === 'evm' && typeof att.manifest.deployedBytecode !== 'string') throw new PolicyError('evm manifest needs deployedBytecode', 'schema');
  const ref = await putBlob(db, j(att.manifest));
  const hash = att.manifest.sha256;
  const id = 'art_' + sha256(`${att.protocol}|${hash}|${att.manifest.sourceSha256}`).slice(0, 14);
  await db.run('INSERT OR IGNORE INTO artifacts(id,run_id,kind,immutable_ref,hash,commit_sha,test_results,created_at) VALUES(?,?,?,?,?,?,?,?)',
    [id, null, `contract-build:${att.protocol}`, ref, hash, att.commitSha ?? null, j(att.tests), now()]);
  await audit(db, actor, 'artifact.attested', { id, protocol: att.protocol, hash, tests: { passed: att.tests.passed, failed: att.tests.failed } });
  return { id, hash };
}
