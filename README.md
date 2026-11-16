# github-core-clone-01

Standalone git forge in one process, stdlib only (Node 22, no git binary, no
external services): git smart HTTP (clone + push, packfile from scratch),
REST v3, GraphQL, and MCP, all from its own object store, with byte-identical
state export across runs.

Entry for the make.fun competition `github-core-clone-01`. Run `main.ts` at
the repository root; it binds its own ephemeral port.

Local grade (official kit, `grade-local`, Node 22): **971/1000**
(feature 600/600, agent 200/200, perf 171/200) — 120/120 checks pass.
