// Test helper: replaces fetch() so the generator can be exercised without network access.
// Scenario comes from the MOCK_GITHUB env var (JSON). Loaded with `node --import`.
const s = JSON.parse(process.env.MOCK_GITHUB || '{}');
const repos = s.repos || [
  { nameWithOwner: 'ArnauAlemanyDev/ArnauAlemanyDev', stargazerCount: 0, isFork: false },
  { nameWithOwner: 'ArnauAlemanyDev/Zent', stargazerCount: 3, isFork: false },
];
const pageSize = s.pageSize || 100;
let calls = 0;

const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

globalThis.fetch = async (url, opts = {}) => {
  url = String(url);
  if (url.includes('api.github.com/graphql')) {
    calls++;
    if (s.mode === 'http500') return new Response('boom', { status: 500 });
    if (s.mode === 'http401') return new Response('{"message":"Bad credentials"}', { status: 401 });
    if (s.mode === 'flaky' && calls <= (s.failFirst ?? 2)) return new Response('unavailable', { status: 503 });
    if (s.mode === 'notfound') return json({ data: { user: null }, errors: [{ type: 'NOT_FOUND', message: "Could not resolve to a User with the login 'x'." }] });
    const { after } = JSON.parse(opts.body).variables;
    const start = after ? Number(after) : 0;
    const slice = repos.slice(start, start + pageSize);
    const hasNextPage = start + pageSize < repos.length;
    const repositories = { totalCount: repos.length, pageInfo: { hasNextPage, endCursor: String(start + pageSize) }, nodes: slice };
    if (after) return json({ data: { user: { repositories } } });
    const weeks = s.mode === 'empty-calendar' ? [] : Array.from({ length: 53 }, (_, w) => ({ contributionDays: Array.from({ length: 7 }, (_, d) => ({ contributionCount: w === 52 && d === 0 ? 9 : w === 20 && d === 3 ? 2 : 0 })) }));
    return json({
      data: {
        user: {
          createdAt: '2026-03-04T10:00:00Z',
          avatarUrl: 'https://avatars.mock/u/1',
          followers: { totalCount: 4 },
          repositories,
          contributionsCollection: { totalCommitContributions: 8, contributionCalendar: { totalContributions: 11, weeks } },
        },
      },
    });
  }
  if (url.includes('avatars.mock')) {
    if (s.mode === 'avatar-fail') return new Response('nope', { status: 404 });
    return new Response(Buffer.from('not-a-real-jpeg-but-bytes'), { status: 200, headers: { 'content-type': 'image/jpeg' } });
  }
  return new Response('not found', { status: 404 }); // e.g. icon CDN: must degrade gracefully
};
