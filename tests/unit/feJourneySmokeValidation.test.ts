import { describe, expect, it } from 'vitest';
import { duplicateCluster } from '../../scripts/smoke-fe-journey-validation.mjs';

describe('fe-journey smoke validation', () => {
  it('finds the duplicate independent of library sort order', () => {
    const representative = {
      canonicalUrl: 'https://www.nowcoder.com/discuss/1001',
      feJourney: { clusterId: 'cluster-a' },
    };
    const duplicate = {
      canonicalUrl: 'https://www.nowcoder.com/discuss/1002',
      feJourney: { clusterId: 'cluster-a', duplicateOf: 'id-1001' },
    };

    expect(duplicateCluster([duplicate, representative])).toEqual({
      clusterId: 'cluster-a',
      duplicateOf: 'id-1001',
    });
    expect(duplicateCluster([representative, duplicate])).toEqual({
      clusterId: 'cluster-a',
      duplicateOf: 'id-1001',
    });
  });
});
