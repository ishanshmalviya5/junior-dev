# slugify-helper — Verification plan

## Highlights

### What gets built
- Automated node:test checks for every slugify behaviour.
- Shell checks for the re-export, dependency-free package.json and local-only git state.

### What doesn't
- No human checks; no manual UI or remote verification.

### Decisions & assumptions
- Every requirement is provable by a script, so all checks are automated.
- Checks run from the worktree root of the toy repo.
- "Local only" is proven by confirming the repo has no configured remote push done by the run (branch has no upstream).

### What needs you
- Nothing; optionally review the branch afterwards.

## Checks

| ID | Kind | Check | Proves | Command |
|---|---|---|---|---|
| U1 | automated | Full test suite passes | C1, A1, A2, A3, A4, A5 | `npm test` |
| U2 | automated | slugify examples from the PRD return expected values | A1, A2, A3, A4 | `node -e "import('./slugify.js').then(({slugify})=>{const c=[['  Hello, World!  ','hello-world'],['','' ],['--Hello--','hello'],['!!!',''],['   ',''],['Café au lait','caf-au-lait'],['Route 66','route-66'],['a   b---c','a-b-c']];for(const [i,o] of c){if(slugify(i)!==o){console.error('FAIL',JSON.stringify(i),slugify(i));process.exit(1)}}})"` |
| U3 | automated | Non-string input throws TypeError | A5 | `node -e "import('./slugify.js').then(({slugify})=>{for(const v of [null,undefined,123]){try{slugify(v);process.exit(1)}catch(e){if(!(e instanceof TypeError))process.exit(1)}}})"` |
| U4 | automated | index.js re-exports the same function | B1 | `node -e "Promise.all([import('./index.js'),import('./slugify.js')]).then(([a,b])=>{if(typeof a.slugify!=='function'||a.slugify!==b.slugify)process.exit(1)})"` |
| U5 | automated | package.json has no dependencies | B1 | `node -e "const p=JSON.parse(require('fs').readFileSync('package.json','utf8'));if(p.dependencies||p.devDependencies)process.exit(1)"` |
| U6 | automated | Test file exists and uses node:test | C1 | `grep -q "node:test" slugify.test.js` |
| U7 | automated | Branch has no upstream (nothing pushed) | C2 | `! git rev-parse --abbrev-ref --symbolic-full-name @{u} 2>/dev/null` |
