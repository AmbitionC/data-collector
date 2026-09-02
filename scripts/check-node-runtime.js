const requestedVersion = process.argv[2] || process.versions.node;
const match = /^v?(\d+)\.(\d+)(?:\.(\d+))?/.exec(requestedVersion);
const major = match ? Number(match[1]) : Number.NaN;
const minor = match ? Number(match[2]) : Number.NaN;
const isSupported = Number.isInteger(major)
  && Number.isInteger(minor)
  && (major > 22 || (major === 22 && minor >= 12));

if (!isSupported) {
  console.error(
    `[data-collector] Node.js ${requestedVersion} is unsupported; `
      + 'data-collector requires Node.js >=22.12.',
  );
  process.exitCode = 1;
}
