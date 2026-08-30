import { createHash } from 'node:crypto';
import type { NowcoderDirectedRunAttempt } from '@data-collector/shared';

function framed(value: string): string {
  return `${Buffer.byteLength(value, 'utf8')}:${value}`;
}

/** Fixed-size protocol-safe identity over complete current-run lineage and canonical URL. */
export function nowcoderDirectedJobId(
  runId: string,
  attempt: NowcoderDirectedRunAttempt,
  canonicalUrl: string,
): string {
  const encoded = [
    'data-collector:nowcoder-directed-job:v1',
    framed(runId),
    framed(attempt),
    framed(canonicalUrl),
  ].join('\u0000');
  return `nowcoder-job-${createHash('sha256').update(encoded, 'utf8').digest('hex')}`;
}
