function parseVersion(value: string) {
  const match =
    /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*))?(?:\+[\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*)?$/.exec(value);
  if (!match) {
    return null;
  }
  const prerelease = match[4]?.split('.') ?? [];
  if (prerelease.some(part => /^0\d+$/.test(part))) {
    return null;
  }
  return { core: match.slice(1, 4).map(BigInt), prerelease };
}

export function compareVersions(left: string, right: string): number | null {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) {
    return null;
  }
  for (let index = 0; index < 3; index++) {
    if (a.core[index] !== b.core[index]) {
      return a.core[index] > b.core[index] ? 1 : -1;
    }
  }
  if (!a.prerelease.length || !b.prerelease.length) {
    return Number(!a.prerelease.length) - Number(!b.prerelease.length);
  }
  for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index++) {
    const x = a.prerelease[index];
    const y = b.prerelease[index];
    if (x === y) {
      continue;
    }
    if (x === undefined || y === undefined) {
      return x === undefined ? -1 : 1;
    }
    const numericX = /^\d+$/.test(x);
    const numericY = /^\d+$/.test(y);
    if (numericX && numericY) {
      return BigInt(x) > BigInt(y) ? 1 : -1;
    }
    if (numericX !== numericY) {
      return numericX ? -1 : 1;
    }
    return x > y ? 1 : -1;
  }
  return 0;
}

export function newestRelease(releases: unknown, installed: string): string | null {
  if (!Array.isArray(releases)) {
    return null;
  }
  const includePrereleases = !!parseVersion(installed)?.prerelease.length;
  let newest = installed;
  for (const release of releases) {
    if (!release || release.draft !== false || typeof release.tag_name !== 'string') {
      continue;
    }
    const parsed = parseVersion(release.tag_name);
    if (!parsed || (!includePrereleases && (release.prerelease !== false || parsed.prerelease.length))) {
      continue;
    }
    if (compareVersions(release.tag_name, newest) === 1) {
      newest = release.tag_name;
    }
  }
  return newest === installed ? null : newest.replace(/^v/, '').split('+')[0];
}
