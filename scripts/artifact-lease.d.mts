export type ArtifactLeaseRole = 'package' | 'zsxq-sink' | (string & {});

export interface ArtifactLeaseOwner {
  version: 1;
  pid: number;
  token: string;
  role: ArtifactLeaseRole;
  startedAt: string;
}

export interface ArtifactLeaseOptions {
  role: ArtifactLeaseRole;
  timeoutMs?: number;
  pollIntervalMs?: number;
  processKill?: (pid: number, signal: 0) => void;
}

export interface ArtifactLease {
  path: string;
  token: string;
  owner: ArtifactLeaseOwner;
  release(): Promise<void>;
}

export declare const ARTIFACT_LEASE_DIRECTORY: '.data-collector-extension-lease';

export declare function artifactLeasePath(workspaceRoot: string): string;

export declare function acquireArtifactLease(
  workspaceRoot: string,
  options: ArtifactLeaseOptions,
): Promise<ArtifactLease>;

export declare function withArtifactLease<T>(
  workspaceRoot: string,
  options: ArtifactLeaseOptions,
  operation: (lease: ArtifactLease) => T | Promise<T>,
): Promise<T>;
