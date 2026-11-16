// Phase 3 smoke: GraphQL + MCP against a live local forge, mirroring the kit conformance
// checks (same documents, same assertions where practical). Run: node smoke-phase3.mjs
import { createApp } from './app.ts';

const TOKEN = 'smoke-token';
let failures = 0;
let checks = 0;

function check(name, ok, detail = '') {
  checks += 1;
  if (!ok) {
    failures += 1;
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function eq(name, actual, expected) {
  check(name, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

async function main() {
  const server = createApp();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  async function req(path, { method = 'GET', token = TOKEN, body = undefined, rawBody = undefined, headers = {} } = {}) {
    const h = { ...headers };
    if (token !== null) h.Authorization = `Bearer ${token}`;
    if (body !== undefined) h['content-type'] = 'application/json';
    const res = await fetch(`${base}${path}`, {
      method,
      headers: h,
      body: rawBody !== undefined ? rawBody : body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* non-JSON body */ }
    return { status: res.status, text, json };
  }

  const gql = async (doc, variables = {}) => {
    const r = await req('/api/graphql', { method: 'POST', body: { query: doc, variables } });
    return r;
  };
  const mcp = async (body, token = TOKEN) => req('/mcp', { method: 'POST', body, token });

  // --- REST setup: repo + main commit + feature branch + 7 issues + 1 PR
  const repoName = 'smoke-gql';
  let r = await req('/api/v3/user/repos', { method: 'POST', body: { name: repoName } });
  eq('rest create repo', r.status, 201);
  r = await req(`/api/v3/repos/adaiversen/${repoName}/contents/README.md`, {
    method: 'PUT', body: { message: 'init', content: Buffer.from('hello\n').toString('base64') },
  });
  eq('rest put contents main', r.status, 201);
  const mainSha = r.json.commit.sha;
  r = await req(`/api/v3/repos/adaiversen/${repoName}/git/refs`, {
    method: 'POST', body: { ref: 'refs/heads/feature', sha: mainSha },
  });
  eq('rest create branch', r.status, 201);
  r = await req(`/api/v3/repos/adaiversen/${repoName}/contents/feature.txt`, {
    method: 'PUT', body: { message: 'feature', content: Buffer.from('feature\n').toString('base64'), branch: 'feature' },
  });
  eq('rest put contents feature', r.status, 201);

  const issueNumbers = [];
  for (let i = 1; i <= 7; i += 1) {
    r = await req(`/api/v3/repos/adaiversen/${repoName}/issues`, {
      method: 'POST', body: { title: `issue ${i}`, body: `body ${i}` },
    });
    eq(`rest create issue ${i}`, r.status, 201);
    issueNumbers.push(r.json.number);
  }
  r = await req(`/api/v3/repos/adaiversen/${repoName}/issues/7`, { method: 'PATCH', body: { state: 'closed' } });
  eq('rest close issue 7', r.status, 200);

  r = await req(`/api/v3/repos/adaiversen/${repoName}/pulls`, {
    method: 'POST', body: { title: 'rest pr', head: 'feature', base: 'main' },
  });
  eq('rest create pr', r.status, 201);
  const prNumber = r.json.number;

  // --- GraphQL: viewer
  r = await gql('query ViewerLogin { viewer { login } }');
  eq('gql viewer status', r.status, 200);
  eq('gql viewer login', r.json.data.viewer.login, 'adaiversen');

  // --- GraphQL: repository fields
  r = await gql(
    `query RepositoryFields($owner: String!, $name: String!, $issueNumber: Int!, $first: Int!, $prNumber: Int!) {
      repository(owner: $owner, name: $name) {
        id databaseId name nameWithOwner
        owner { login }
        defaultBranchRef { name }
        viewerPermission hasIssuesEnabled
        issue(number: $issueNumber) { number title }
        issues(first: $first) { nodes { number title } }
        pullRequests(first: $first) { nodes { number title } }
        pullRequest(number: $prNumber) { number title }
      }
    }`,
    { owner: 'adaiversen', name: repoName, issueNumber: issueNumbers[0], first: 10, prNumber },
  );
  const repo = r.json.data.repository;
  check('gql repo present', repo !== null);
  check('gql repo id opaque', typeof repo.id === 'string' && repo.id.length > 0 && repo.id !== String(repo.databaseId));
  check('gql repo databaseId positive', typeof repo.databaseId === 'number' && repo.databaseId > 0);
  eq('gql repo name', repo.name, repoName);
  eq('gql repo nameWithOwner', repo.nameWithOwner, `adaiversen/${repoName}`);
  eq('gql repo owner login', repo.owner.login, 'adaiversen');
  eq('gql repo defaultBranchRef', repo.defaultBranchRef.name, 'main');
  check('gql viewerPermission', ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'].includes(repo.viewerPermission));
  eq('gql hasIssuesEnabled', repo.hasIssuesEnabled, true);
  eq('gql issue number', repo.issue.number, issueNumbers[0]);
  eq('gql issue title', repo.issue.title, 'issue 1');
  check('gql issues contains issue 1', repo.issues.nodes.some((n) => n.number === issueNumbers[0] && n.title === 'issue 1'));
  check('gql prs contains rest pr', repo.pullRequests.nodes.some((n) => n.number === prNumber && n.title === 'rest pr'));
  eq('gql pr number', repo.pullRequest.number, prNumber);

  // --- GraphQL: introspection
  const introspect = async (typeName, kind) => {
    const field = kind === 'fields' ? 'fields(includeDeprecated: true) { name }' : 'enumValues(includeDeprecated: true) { name }';
    const rr = await gql(`query T($name: String!) { __type(name: $name) { ${field} } }`, { name: typeName });
    return rr.json.data.__type?.[kind]?.map((f) => f.name) ?? null;
  };
  const issueFields = await introspect('Issue', 'fields');
  for (const f of ['id', 'number', 'title', 'state', 'body']) check(`gql introspect Issue has ${f}`, issueFields?.includes(f));
  const prFields = await introspect('PullRequest', 'fields');
  for (const f of ['id', 'number', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files']) check(`gql introspect PR has ${f}`, prFields?.includes(f));
  const repoFields = await introspect('Repository', 'fields');
  for (const f of ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest']) check(`gql introspect Repo has ${f}`, repoFields?.includes(f));
  const searchEnums = await introspect('SearchType', 'enumValues');
  check('gql introspect SearchType has ISSUE', searchEnums?.includes('ISSUE'));

  // --- GraphQL: issues pagination
  r = await gql(
    `query IssuesPage($owner: String!, $name: String!, $first: Int!, $after: String) {
      repository(owner: $owner, name: $name) { issues(first: $first, after: $after) { nodes { number } pageInfo { hasNextPage endCursor } } }
    }`,
    { owner: 'adaiversen', name: repoName, first: 5, after: null },
  );
  const page1 = r.json.data.repository.issues;
  eq('gql page1 size', page1.nodes.length, 5);
  eq('gql page1 hasNextPage', page1.pageInfo.hasNextPage, true);
  check('gql page1 endCursor', typeof page1.pageInfo.endCursor === 'string' && page1.pageInfo.endCursor.length > 0);
  r = await gql(
    `query IssuesPage($owner: String!, $name: String!, $first: Int!, $after: String) {
      repository(owner: $owner, name: $name) { issues(first: $first, after: $after) { nodes { number } pageInfo { hasNextPage endCursor } } }
    }`,
    { owner: 'adaiversen', name: repoName, first: 5, after: page1.pageInfo.endCursor },
  );
  const page2 = r.json.data.repository.issues;
  eq('gql page2 size', page2.nodes.length, 2);
  eq('gql page2 hasNextPage', page2.pageInfo.hasNextPage, false);
  const allNums = [...page1.nodes, ...page2.nodes].map((n) => n.number);
  eq('gql pagination covers 7 distinct', new Set(allNums).size, 7);

  // --- GraphQL: open issues ordered DESC
  r = await gql(
    `query OpenOrder($owner: String!, $name: String!, $first: Int!) {
      repository(owner: $owner, name: $name) { issues(first: $first, states: [OPEN], orderBy: {field: CREATED_AT, direction: DESC}) { nodes { number state } } }
    }`,
    { owner: 'adaiversen', name: repoName, first: 10 },
  );
  const openNodes = r.json.data.repository.issues.nodes;
  eq('gql open issues count', openNodes.length, 6);
  const nums = openNodes.map((n) => n.number);
  check('gql open issues descending', nums.every((n, i) => i === 0 || n < nums[i - 1]), nums.join(','));
  check('gql open issues all OPEN', openNodes.every((n) => n.state === 'OPEN'));

  // --- GraphQL: createIssue + closeIssue
  r = await gql(
    `mutation CreateIssue($input: CreateIssueInput!) { createIssue(input: $input) { issue { number id } } }`,
    { input: { repositoryId: repo.id, title: 'gql issue', body: 'gql body' } },
  );
  const gqlIssue = r.json.data.createIssue.issue;
  check('gql createIssue number', typeof gqlIssue.number === 'number' && gqlIssue.number > 0);
  check('gql createIssue id opaque', typeof gqlIssue.id === 'string' && gqlIssue.id.length > 0);
  r = await req(`/api/v3/repos/adaiversen/${repoName}/issues/${gqlIssue.number}`);
  eq('gql issue visible via REST', r.json.title, 'gql issue');

  r = await gql(
    `mutation CloseIssue($input: CloseIssueInput!) { closeIssue(input: $input) { issue { number id state } } }`,
    { input: { issueId: gqlIssue.id } },
  );
  eq('gql closeIssue state', r.json.data.closeIssue.issue.state, 'CLOSED');
  eq('gql closeIssue number', r.json.data.closeIssue.issue.number, gqlIssue.number);

  // --- GraphQL: createPullRequest + mergePullRequest
  r = await gql(
    `mutation CreatePR($input: CreatePullRequestInput!) { createPullRequest(input: $input) { pullRequest { number id state headRefName baseRefName } } }`,
    { input: { repositoryId: repo.id, baseRefName: 'main', headRefName: 'feature', title: 'gql pr' } },
  );
  const gqlPr = r.json.data.createPullRequest.pullRequest;
  check('gql createPR number', typeof gqlPr.number === 'number' && gqlPr.number === 10);
  eq('gql createPR state', gqlPr.state, 'OPEN');
  eq('gql createPR head', gqlPr.headRefName, 'feature');
  eq('gql createPR base', gqlPr.baseRefName, 'main');
  r = await req(`/api/v3/repos/adaiversen/${repoName}/pulls/${gqlPr.number}`);
  eq('gql pr visible via REST', r.json.title, 'gql pr');

  r = await gql(
    `query PRFiles($owner: String!, $name: String!, $number: Int!) {
      repository(owner: $owner, name: $name) { pullRequest(number: $number) { mergeable files(first: 10) { nodes { path } } } }
    }`,
    { owner: 'adaiversen', name: repoName, number: gqlPr.number },
  );
  const prData = r.json.data.repository.pullRequest;
  check('gql pr mergeable enum', ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'].includes(prData.mergeable), prData.mergeable);
  check('gql pr files include feature.txt', prData.files.nodes.some((f) => f.path === 'feature.txt'));

  r = await gql(
    `mutation MergePR($input: MergePullRequestInput!) { mergePullRequest(input: $input) { pullRequest { number merged state } } }`,
    { input: { pullRequestId: gqlPr.id, mergeMethod: 'SQUASH' } },
  );
  eq('gql mergePR merged', r.json.data.mergePullRequest.pullRequest.merged, true);
  r = await req(`/api/v3/repos/adaiversen/${repoName}/pulls/${gqlPr.number}`);
  eq('gql merged pr REST merged', r.json.merged, true);
  eq('gql merged pr REST state', r.json.state, 'closed');

  // --- GraphQL: addComment
  r = await gql(
    `mutation AddComment($input: AddCommentInput!) { addComment(input: $input) { commentEdge { node { id body } } } }`,
    { input: { subjectId: gqlIssue.id, body: 'gql comment' } },
  );
  eq('gql addComment body', r.json.data.addComment.commentEdge.node.body, 'gql comment');
  r = await req(`/api/v3/repos/adaiversen/${repoName}/issues/${gqlIssue.number}/comments`);
  check('gql comment visible via REST', Array.isArray(r.json) && r.json.some((c) => c.body === 'gql comment'));

  // --- GraphQL: node()
  r = await gql(
    `query NodeRepo($id: ID!) { node(id: $id) { __typename ... on Repository { name nameWithOwner } } }`,
    { id: repo.id },
  );
  eq('gql node repo name', r.json.data.node.name, repoName);
  eq('gql node repo nameWithOwner', r.json.data.node.nameWithOwner, `adaiversen/${repoName}`);

  // --- GraphQL: invalid field / unknown repo / batch / unauthenticated
  r = await gql('query Bad { viewer { login noSuchFieldOnViewer } }');
  eq('gql invalid field status', r.status, 200);
  check('gql invalid field errors name it', JSON.stringify(r.json.errors ?? []).includes('noSuchFieldOnViewer'));
  r = await gql('query UnknownRepo($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { id } }', { owner: 'adaiversen', name: 'no-such-repo' });
  eq('gql unknown repo null', r.json.data.repository, null);
  check('gql unknown repo no errors', !('errors' in r.json) || r.json.errors === undefined);
  r = await req('/api/graphql', { method: 'POST', body: [{ query: 'query A { viewer { login } }' }, { query: 'query B { viewer { login } }' }] });
  check('gql batch array of 2', Array.isArray(r.json) && r.json.length === 2 && r.json[0].data.viewer.login === 'adaiversen' && r.json[1].data.viewer.login === 'adaiversen');
  r = await gql('query ViewerLogin { viewer { login } }').catch((e) => e);
  r = await req('/api/graphql', { method: 'POST', token: null, body: { query: 'query { viewer { login } }' } });
  eq('gql unauthenticated 401', r.status, 401);

  // --- MCP: discover + initialize + tools/list
  r = await mcp({ jsonrpc: '2.0', id: 1, method: 'server/discover', params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' } } });
  eq('mcp discover status', r.status, 200);
  check('mcp discover versions', Array.isArray(r.json.result.supportedVersions) && r.json.result.supportedVersions.length > 0);
  check('mcp discover serverInfo', r.json.result.serverInfo?.name === 'github-core-clone-forge');
  check('mcp discover _meta serverInfo', r.json.result._meta?.['io.modelcontextprotocol/serverInfo']?.name === 'github-core-clone-forge');

  r = await mcp({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } } });
  eq('mcp initialize protocolVersion', r.json.result.protocolVersion, '2025-11-25');

  const toolNames = ['create_repo', 'get_repo', 'create_issue', 'list_issues', 'create_pull_request', 'merge_pull_request'];
  const list1 = await mcp({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} });
  const list2 = await mcp({ jsonrpc: '2.0', id: 4, method: 'tools/list', params: {} });
  check('mcp tools/list identical twice', JSON.stringify(list1.json) === JSON.stringify({ ...list2.json, id: 3 }) || JSON.stringify(list1.json.result) === JSON.stringify(list2.json.result));
  const tools = list1.json.result.tools;
  check('mcp tools >= 6', tools.length >= 6);
  for (const name of toolNames) check(`mcp tool ${name} present`, tools.some((t) => t.name === name));
  for (const t of tools) check(`mcp tool ${t.name} schema`, typeof t.description === 'string' && t.description.length > 0 && t.inputSchema?.type === 'object');

  // --- MCP: rest-parity (repo + issue), tools act on the same store
  let callId = 10;
  const call = async (name, args, token = TOKEN) => {
    callId += 1;
    return mcp({ jsonrpc: '2.0', id: callId, method: 'tools/call', params: { name, arguments: args } }, token);
  };
  r = await call('create_repo', { name: 'mcp-repo', description: 'mcp desc', private: false });
  const mcpRepo = r.json.result.structuredContent;
  eq('mcp create_repo name', mcpRepo.name, 'mcp-repo');
  r = await req('/api/v3/repos/adaiversen/mcp-repo');
  eq('mcp repo REST id matches', r.json.id, mcpRepo.id);
  eq('mcp repo REST name matches', r.json.name, mcpRepo.name);
  eq('mcp repo REST full_name matches', r.json.full_name, mcpRepo.full_name);
  eq('mcp repo REST description matches', r.json.description, mcpRepo.description);
  eq('mcp repo REST private matches', r.json.private, mcpRepo.private);
  eq('mcp repo REST default_branch matches', r.json.default_branch, mcpRepo.default_branch);
  eq('mcp repo REST owner login matches', r.json.owner.login, mcpRepo.owner.login);

  r = await call('create_issue', { owner: 'adaiversen', repo: 'mcp-repo', title: 'mcp issue', body: 'mcp body' });
  const mcpIssue = r.json.result.structuredContent;
  eq('mcp create_issue title', mcpIssue.title, 'mcp issue');
  r = await req(`/api/v3/repos/adaiversen/mcp-repo/issues/${mcpIssue.number}`);
  eq('mcp issue REST id matches', r.json.id, mcpIssue.id);
  eq('mcp issue REST title matches', r.json.title, mcpIssue.title);
  eq('mcp issue REST state matches', r.json.state, mcpIssue.state);

  r = await call('list_issues', { owner: 'adaiversen', repo: 'mcp-repo', state: 'open' });
  const listText = r.json.result.content[0].text;
  check('mcp list_issues text includes title', listText.includes('mcp issue'));

  r = await call('get_repo', { owner: 'adaiversen', repo: 'mcp-repo' });
  check('mcp get_repo text includes name', r.json.result.content[0].text.includes('mcp-repo'));

  // --- MCP: create + merge a pull request (needs branches: reuse REST contents)
  r = await req('/api/v3/repos/adaiversen/mcp-repo/contents/a.txt', {
    method: 'PUT', body: { message: 'init', content: Buffer.from('a\n').toString('base64') },
  });
  eq('mcp repo init commit', r.status, 201);
  const baseSha = r.json.commit.sha;
  r = await req('/api/v3/repos/adaiversen/mcp-repo/git/refs', {
    method: 'POST', body: { ref: 'refs/heads/mcp-feature', sha: baseSha },
  });
  eq('mcp repo branch', r.status, 201);
  r = await req('/api/v3/repos/adaiversen/mcp-repo/contents/b.txt', {
    method: 'PUT', body: { message: 'b', content: Buffer.from('b\n').toString('base64'), branch: 'mcp-feature' },
  });
  eq('mcp repo feature commit', r.status, 201);
  r = await call('create_pull_request', { owner: 'adaiversen', repo: 'mcp-repo', title: 'mcp pr', head: 'mcp-feature', base: 'main' });
  const mcpPr = r.json.result.structuredContent;
  check('mcp create_pr number', typeof mcpPr.number === 'number');
  eq('mcp create_pr head', mcpPr.head, 'mcp-feature');
  eq('mcp create_pr base', mcpPr.base, 'main');
  r = await call('merge_pull_request', { owner: 'adaiversen', repo: 'mcp-repo', pull_number: mcpPr.number });
  eq('mcp merge_pr merged', r.json.result.structuredContent.merged, true);

  // --- MCP: errors
  r = await call('not_a_tool', {});
  eq('mcp unknown tool code', r.json.error.code, -32602);
  r = await mcp({ jsonrpc: '2.0', id: 99, method: 'tools/call', params: { name: 'create_issue', arguments: { owner: 'adaiversen' } } });
  eq('mcp missing args isError', r.json.result.isError, true);
  r = await req('/mcp', { method: 'POST', token: null, body: { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} } });
  eq('mcp unauthenticated 401', r.status, 401);
  r = await req('/mcp', { method: 'POST', rawBody: '{not json' });
  eq('mcp parse error status', r.status, 400);
  eq('mcp parse error code', r.json.error.code, -32700);
  r = await mcp({ jsonrpc: '2.0', id: 100, method: 'no/such/method', params: {} });
  eq('mcp unknown method code', r.json.error.code, -32601);

  // --- MCP: concurrent calls keep their own ids
  const [c1, c2] = await Promise.all([
    mcp({ jsonrpc: '2.0', id: 'aaa', method: 'tools/call', params: { name: 'get_repo', arguments: { owner: 'adaiversen', repo: 'mcp-repo' } } }),
    mcp({ jsonrpc: '2.0', id: 'bbb', method: 'tools/call', params: { name: 'get_repo', arguments: { owner: 'adaiversen', repo: repoName } } }),
  ]);
  eq('mcp concurrent id aaa', c1.json.id, 'aaa');
  eq('mcp concurrent id bbb', c2.json.id, 'bbb');
  check('mcp concurrent aaa repo', c1.json.result.content[0].text.includes('mcp-repo'));
  check('mcp concurrent bbb repo', c2.json.result.content[0].text.includes(repoName));

  server.close();
  console.log(`\nphase3 smoke: ${checks - failures}/${checks} checks passed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
